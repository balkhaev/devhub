import { execFile } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { AiError } from "./ai/types";

const runFile = promisify(execFile);
const WINDOWS_USER_CSV = /^"(?:[^"\r\n]|"")*","(S-1-\d+(?:-\d+)+)"$/;
const WINDOWS_OPTIONS = {
	encoding: "utf8" as const,
	maxBuffer: 65_536,
	timeout: 10_000,
	windowsHide: true,
};
let windowsSid: Promise<string> | undefined;
const VERIFY_ACL = `$Target = [Environment]::GetEnvironmentVariable("DEVHUB_PRIVATE_ACL_TARGET")
$CurrentSid = [Environment]::GetEnvironmentVariable("DEVHUB_PRIVATE_ACL_SID")
$Kind = [Environment]::GetEnvironmentVariable("DEVHUB_PRIVATE_ACL_KIND")
$Protection = [Environment]::GetEnvironmentVariable("DEVHUB_PRIVATE_ACL_PROTECTION")
$ErrorActionPreference = "Stop"
if ($Kind -eq "directory") {
 $Acl = [System.IO.Directory]::GetAccessControl($Target)
} else {
 $Acl = [System.IO.File]::GetAccessControl($Target)
}
$Trusted = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
[void]$Trusted.Add($CurrentSid)
[void]$Trusted.Add("S-1-5-18")
[void]$Trusted.Add("S-1-5-32-544")
if (-not $Trusted.Contains($Acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value)) {
 throw "Secret owner is not trusted"
}
if ($Protection -eq "direct" -and -not $Acl.AreAccessRulesProtected) {
 throw "Secret ACL inheritance remains enabled"
}
$Seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
foreach ($Rule in $Acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
 $Identity = $Rule.IdentityReference.Value
 if (-not $Trusted.Contains($Identity) -or $Rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
  throw "Unexpected secret ACL identity or deny rule"
 }
 if (($Rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl) {
  throw "Incomplete secret ACL rights"
 }
 [void]$Seen.Add($Identity)
}
if ($Seen.Count -ne $Trusted.Count) { throw "Missing trusted secret ACL identity" }
`;

function systemExecutable(name: string): string {
	return join(process.env.SystemRoot ?? "C:\\Windows", "System32", name);
}

async function lookupWindowsSid(): Promise<string> {
	const identity = await runFile(
		systemExecutable("whoami.exe"),
		["/user", "/fo", "csv", "/nh"],
		WINDOWS_OPTIONS
	);
	const sid = WINDOWS_USER_CSV.exec(identity.stdout.trim())?.[1];
	if (!sid) {
		throw new Error("Current Windows SID is unavailable");
	}
	return sid;
}

function currentWindowsSid(): Promise<string> {
	windowsSid ??= lookupWindowsSid();
	return windowsSid;
}

/** Verify the resulting DACL: icacls /grant:r retains unrelated explicit grants. */
async function verifyWindowsAcl(
	target: string,
	sid: string,
	kind: "file" | "directory",
	protection: "direct" | "any" = "direct"
): Promise<void> {
	await runFile(
		systemExecutable(join("WindowsPowerShell", "v1.0", "powershell.exe")),
		[
			"-NoProfile",
			"-NonInteractive",
			"-EncodedCommand",
			Buffer.from(VERIFY_ACL, "utf16le").toString("base64"),
		],
		{
			...WINDOWS_OPTIONS,
			env: {
				...process.env,
				DEVHUB_PRIVATE_ACL_KIND: kind,
				DEVHUB_PRIVATE_ACL_PROTECTION: protection,
				DEVHUB_PRIVATE_ACL_SID: sid,
				DEVHUB_PRIVATE_ACL_TARGET: target,
			},
		}
	);
}

/** Protect only an owned secret directory whose children are ordinary owned files. */
export async function protectPrivateDirectory(
	directory: string
): Promise<void> {
	if (process.platform !== "win32") {
		return;
	}
	try {
		const metadata = await lstat(directory);
		if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
			throw new Error("Secret directory must be an ordinary owned directory");
		}
		const entries = await readdir(directory, { withFileTypes: true });
		if (entries.some((entry) => !entry.isFile())) {
			throw new Error("Unexpected entry in the owned secret directory");
		}
		const sid = await currentWindowsSid();
		// POSIX modes do not restrict Windows access. New files inherit these
		// private grants; changing the parent .state directory is unnecessary.
		await runFile(
			systemExecutable("icacls.exe"),
			[
				directory,
				"/inheritance:r",
				"/grant:r",
				`*${sid}:(OI)(CI)F`,
				"*S-1-5-18:(OI)(CI)F",
				"*S-1-5-32-544:(OI)(CI)F",
				"/Q",
			],
			WINDOWS_OPTIONS
		);
		await verifyWindowsAcl(directory, sid, "directory");
		for (const entry of entries) {
			// Recursive (OI)/(CI) grants are ineffective on files. Reset each exact
			// owned path from its now-private parent without traversing links.
			// biome-ignore lint/performance/noAwaitInLoops: each owned file inherits the already-protected directory ACL.
			await runFile(
				systemExecutable("icacls.exe"),
				[join(directory, entry.name), "/reset", "/Q"],
				WINDOWS_OPTIONS
			);
			await verifyWindowsAcl(join(directory, entry.name), sid, "file", "any");
		}
	} catch (error) {
		throw new AiError(
			"Не удалось ограничить доступ к хранилищу секретов. Файлы сохранены; проверьте права Windows и перезапустите DevHub.",
			{ cause: error, status: 500 }
		);
	}
}

/** The caller must create an empty new file, protect it, then write its secret. */
export async function protectPrivateFile(file: string): Promise<void> {
	if (process.platform !== "win32") {
		return;
	}
	try {
		const metadata = await lstat(file);
		if (!metadata.isFile() || metadata.isSymbolicLink()) {
			throw new Error("Secret file must be an ordinary owned file");
		}
		const sid = await currentWindowsSid();
		await runFile(
			systemExecutable("icacls.exe"),
			[
				file,
				"/inheritance:r",
				"/grant:r",
				`*${sid}:F`,
				"*S-1-5-18:F",
				"*S-1-5-32-544:F",
				"/Q",
			],
			WINDOWS_OPTIONS
		);
		await verifyWindowsAcl(file, sid, "file");
	} catch (error) {
		throw new AiError(
			"Не удалось ограничить доступ к секретному файлу. Файл сохранён; проверьте права Windows и перезапустите DevHub.",
			{ cause: error, status: 500 }
		);
	}
}

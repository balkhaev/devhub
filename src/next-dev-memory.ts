const NEXT_DEV = /(?:^|[\s"'/\\])next(?:\.cmd|\.exe)?["']?\s+dev(?:\s|$)/;
const HEAP_LIMIT = /--max[-_]old[-_]space[-_]size/;

/** Node heap limit, in MB, that a `next dev` service gets unless its NODE_OPTIONS already sets one. */
export const NEXT_DEV_HEAP_MB = 4096;

/**
 * `next dev` raises Node's heap limit to half of the machine's memory when NODE_OPTIONS sets none
 * (about 32 GB on a 64 GB machine), and Next restarts its own dev server only once the used heap
 * passes 80 % of that limit. A long session of edits therefore grew one server to 20 GB
 * (luvclub/web, 2026-10-26). With a 4 GB limit Next restarts itself near 10 GB and comes back in
 * under a second. Returns the NODE_OPTIONS to use, or undefined when nothing changes.
 */
export function nextDevNodeOptions(
	command: string | undefined,
	nodeOptions: string | undefined
): string | undefined {
	if (
		!(command && NEXT_DEV.test(command)) ||
		HEAP_LIMIT.test(nodeOptions ?? "")
	) {
		return;
	}
	return [nodeOptions?.trim(), `--max-old-space-size=${NEXT_DEV_HEAP_MB}`]
		.filter(Boolean)
		.join(" ");
}

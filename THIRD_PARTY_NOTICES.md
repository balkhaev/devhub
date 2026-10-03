# Third-party notices

## OmniRoute

DevHub adapts OAuth protocol configuration and interoperability behavior studied in
[OmniRoute](https://github.com/diegosouzapw/OmniRoute), pinned to commit
`23a11484862b3bb589a55e85b00e4ac53ffeb234`.

The adapted areas are Claude OAuth authorization/code exchange and refresh
configuration, Codex CLI credential import and legacy Responses endpoint behavior,
Claude CLI credential import, and provider model discovery and stream handling.
Relevant upstream sources include `src/lib/oauth/constants/oauth.ts`,
`src/lib/oauth/providers/{claude,codex}.ts`,
`src/lib/oauth/utils/{claude,codex}AuthImport.ts`,
`open-sse/services/tokenRefresh/providers/{claudeOAuth,codex}.ts`, and
`open-sse/executors/codex.ts`.

OpenAI Sign in with ChatGPT plan usage also follows the official OpenAI
registration, OAuth, and inference documentation. DevHub identifies itself to
providers and does not include OmniRoute's Claude Code impersonation, device
cloaking, or client fingerprint obfuscation layers.

The upstream license and copyright notice are reproduced below.

```text
MIT License

Copyright (c) 2026 diegosouzapw

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
// Ambient types for the Agent SDK's platform CLI binaries, embedded via
// `with { type: "file" }` in the generated asset shim. The upstream packages
// ship native binaries and no types; the default export is the embedded (or,
// running from source, the real node_modules) binary path as a string.
declare module "@anthropic-ai/claude-agent-sdk-linux-x64/claude" {
  const path: string;
  export default path;
}

declare module "@anthropic-ai/claude-agent-sdk-linux-arm64/claude" {
  const path: string;
  export default path;
}

declare module "@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe" {
  const path: string;
  export default path;
}

declare module "@anthropic-ai/claude-agent-sdk-win32-arm64/claude.exe" {
  const path: string;
  export default path;
}

// Category mapping for the OpenHub catalog.
// Ordered by specificity: the first categories that match win the display order.
// Match is exact token, case-insensitive, over npm keywords + GitHub topics.

export const CATEGORIES = [
  ["mcp", ["mcp", "model-context-protocol", "mcp-server", "mcp-client"]],
  ["providers", ["provider", "providers", "llm", "openai", "anthropic", "gemini", "ollama", "openrouter", "bedrock", "groq", "mistral"]],
  ["auth", ["auth", "oauth", "login", "token", "credentials", "keychain", "authentication"]],
  ["memory", ["memory", "rag", "retrieval", "embeddings", "knowledge-base", "knowledgebase", "mem0"]],
  ["observability", ["telemetry", "tracing", "metrics", "otel", "observability", "analytics", "logging"]],
  ["notify", ["notification", "notifications", "notify", "alert", "sound", "telegram", "discord", "slack"]],
  ["git", ["git", "github", "gitlab", "commit", "pull-request", "review", "diff", "branch"]],
  ["lsp", ["lsp", "language-server", "diagnostics", "code-intelligence"]],
  ["ui", ["ui", "theme", "themes", "tui", "statusline", "status-bar", "widget", "terminal"]],
  ["agents", ["agent", "agents", "subagent", "subagents", "orchestration", "planner", "swarm", "automation"]],
  ["testing", ["test", "testing", "tdd", "coverage"]],
  ["infra", ["docker", "kubernetes", "deploy", "deployment", "ci", "sandbox", "worktree"]],
  ["tools", ["tool", "tools", "editor", "search", "file", "shell", "command"]],
];

export const CATEGORY_NAMES = CATEGORIES.map(([name]) => name);

export function categoriesFor(keywords = [], topics = [], override) {
  const tokens = new Set(
    [...keywords, ...topics]
      .map((t) => String(t).toLowerCase().trim())
      .filter(Boolean),
  );
  const hits = CATEGORIES.filter(([, words]) => words.some((w) => tokens.has(w))).map(
    ([name]) => name,
  );
  if (override) return [override, ...hits.filter((c) => c !== override)];
  return hits.length ? hits : ["other"];
}

// ACP combines planning and approval policy in a single native mode.
export function mapPromptMode(line: string): string {
  let request;
  try { request = JSON.parse(line); } catch { return line; }
  if (request?.method !== "turn/start" || !request.params?.options) return line;
  const options = request.params.options;
  options.sessionOptions = {
    ...options.sessionOptions,
    mode: options.promptMode === "plan" ? "plan" : "accept-edits",
  };
  return JSON.stringify(request);
}

# Protocol Fixtures

协议 fixture 按各厂商公开协议文档手写，非真实录制。所有 ID、fingerprint、usage 数字均为脱敏占位值，
不包含任何真实请求、响应或凭据。

Each `<family>/<case>.sse.json` file is a JSON array in which every item is one SSE `data:` payload
object (or the literal string `"[DONE]"`). Replaying a fixture means emitting each item as
`data: <json>\n\n`, which the package tests feed into the protocol stream consumers under arbitrary
chunk boundaries.

- `kimi/`, `qwen/`, `glm/`, `deepseek/` follow the OpenAI-compatible chat-completions chunk shape
  (`delta.content` / `delta.reasoning_content` / `delta.tool_calls`, `system_fingerprint` where the
  vendor documents it).
- `minimax/` follows the Anthropic messages event shape (`message_start`, `content_block_*`,
  `message_delta`, `message_stop`).

Cases per family: `text`, `reasoning`, `tool`, `usage` cover the happy paths; `image` (families with
image input) covers a vision response; `abort` captures a stream cut short without a finish reason or
`[DONE]`; `overflow` captures a length-limited finish (`length` / `max_tokens`).

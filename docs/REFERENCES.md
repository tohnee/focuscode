# Primary implementation references

Provider、OAuth、隔离和 npm 实现以一手规范/官方文档为准：

- [OAuth 2.0 Authorization Framework — RFC 6749](https://www.rfc-editor.org/rfc/rfc6749)
- [Proof Key for Code Exchange — RFC 7636](https://www.rfc-editor.org/rfc/rfc7636)
- [OAuth 2.0 Device Authorization Grant — RFC 8628](https://www.rfc-editor.org/rfc/rfc8628)
- [Google OAuth 2.0](https://developers.google.com/identity/protocols/oauth2)
- [GitHub OAuth app authorization](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
- [OpenAI Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [OpenAI image and vision inputs](https://developers.openai.com/api/docs/guides/images-vision)
- [Anthropic vision](https://platform.claude.com/docs/en/build-with-claude/vision)
- [Gemini function calling](https://ai.google.dev/gemini-api/docs/function-calling)
- [Gemini text and multimodal generation](https://ai.google.dev/gemini-api/docs/text-generation)
- [gVisor Docker quick start](https://gvisor.dev/docs/user_guide/quick_start/docker/)
- [Firecracker microVM](https://firecracker-microvm.github.io/)
- [npm package.json](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/)
- [npm audit signatures](https://docs.npmjs.com/cli/v8/commands/npm-audit/)
- [npm publish](https://docs.npmjs.com/cli/v8/commands/npm-publish/)

外部服务会演进；发布 Provider adapter 或部署 runtime 前应重新运行 recorded fixtures 和目标
平台 smoke tests，不能只依赖文档链接或历史兼容性。

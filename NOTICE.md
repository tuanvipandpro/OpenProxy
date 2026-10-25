# Third-party components

OpenProxy is a Windows desktop application and local Node.js proxy maintained at https://github.com/tuanvipandpro/OpenProxy.

## Proxy engine

The application uses the unchanged `claude-code-proxy` engine from https://github.com/raine/claude-code-proxy, release **v0.1.46**, under the MIT license. The original copyright notice is preserved in [LICENSE](LICENSE) and in the packaged `licenses/claude-code-proxy-LICENSE.txt`.

Reference source commit: `5261067510fd00dd5efcadab3ecf79b8e02b4f80`. See [openproxy/upstream.json](openproxy/upstream.json). Engine downloads are checked against the upstream release SHA-256 before installation. Upstream source remains available from its repository and the retained Git history; OpenProxy does not build or modify it.

## Node.js runtime

Portable Windows packages include the Node.js runtime used during the build. Its license and third-party notices are included in `licenses/Node-LICENSE.txt`. The exact Node version is recorded in `build-info.json`.

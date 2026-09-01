import { loadConfig } from './config.js';
import { createApp, SERVER_NAME } from './app.js';

const config = loadConfig();
const app = createApp(config);

app.listen(config.port, () => {
    console.log(`${SERVER_NAME} MCP server listening on ${config.publicUrl.origin}`);
    console.log(`  MCP endpoint   ${config.resourceUrl.href}`);
    console.log(`  Unimicro API   ${config.apiBaseUrl.origin}`);
    console.log(`  Identity       ${config.issuer.origin}`);
});

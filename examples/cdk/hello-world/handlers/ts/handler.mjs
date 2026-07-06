import { createApp, json } from "./vendor/apptheory/index.js";

import { buildHelloWorldApp } from "./app.mjs";

const app = buildHelloWorldApp({ createApp, json });

export const handler = async (event, context) => app.handleLambda(event, context);

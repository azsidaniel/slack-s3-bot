import 'dotenv/config';

import { createSlackApp } from './slack.js';

const requiredEnvVars = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'S3_BUCKET'];

const missingEnvVars = requiredEnvVars.filter((envVar) => !process.env[envVar]);

if (missingEnvVars.length > 0) {
  throw new Error(`Variaveis de ambiente ausentes: ${missingEnvVars.join(', ')}`);
}

const app = createSlackApp();
const port = Number(process.env.PORT || 3000);

await app.start(port);

console.log('Slack S3 Assets Bot iniciado em Socket Mode.');

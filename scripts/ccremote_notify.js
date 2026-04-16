#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = { ccrRoot: '' };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--ccr-root') {
      args.ccrRoot = argv[i + 1] || '';
      i += 1;
    }
  }
  return args;
}

async function readStdin() {
  return await new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.ccrRoot) {
    throw new Error('--ccr-root is required');
  }

  const ccrRoot = path.resolve(args.ccrRoot);
  const payloadText = (await readStdin()).trim();
  if (!payloadText) {
    throw new Error('notification payload is required on stdin');
  }

  const payload = JSON.parse(payloadText);
  const envPath = path.join(ccrRoot, '.env');
  if (fs.existsSync(envPath)) {
    const dotenv = require(path.join(ccrRoot, 'node_modules/dotenv'));
    dotenv.config({ path: envPath });
  }

  const ConfigManager = require(path.join(ccrRoot, 'src/core/config'));
  const config = new ConfigManager();
  config.load();

  const notification = {
    type: payload.type || 'waiting',
    title: payload.title || 'TNS Report',
    message: payload.message || 'TNS update',
    project: payload.project || path.basename(process.cwd()),
    metadata: payload.metadata || {},
  };

  const channelLoaders = {
    desktop: () => require(path.join(ccrRoot, 'src/channels/local/desktop')),
    email: () => require(path.join(ccrRoot, 'src/channels/email/smtp')),
    telegram: () => require(path.join(ccrRoot, 'src/channels/telegram/telegram')),
    line: () => require(path.join(ccrRoot, 'src/channels/line/line')),
  };

  const results = {};
  const tasks = [];
  for (const [name, loader] of Object.entries(channelLoaders)) {
    const channelConfig = config.getChannel(name);
    if (!channelConfig || channelConfig.enabled === false) {
      results[name] = { success: false, reason: 'disabled' };
      continue;
    }
    let ChannelClass;
    try {
      ChannelClass = loader();
    } catch (error) {
      results[name] = { success: false, error: `load_failed: ${error.message}` };
      continue;
    }
    const channel = new ChannelClass(channelConfig.config || {});
    if (!channel.enabled) {
      results[name] = { success: false, reason: 'disabled' };
      continue;
    }
    if (typeof channel.validateConfig === 'function' && !channel.validateConfig()) {
      results[name] = { success: false, reason: 'not_configured' };
      continue;
    }
    tasks.push(
      channel.send(notification)
        .then(success => {
          results[name] = { success: !!success };
        })
        .catch(error => {
          results[name] = { success: false, error: error.message };
        })
    );
  }

  await Promise.all(tasks);
  const success = Object.values(results).some(item => item.success);
  process.stdout.write(JSON.stringify({ success, results }) + '\n');
  if (!success) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});

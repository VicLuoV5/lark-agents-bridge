import { Command } from 'commander';
import pkg from '../../package.json';
import { runMigrate } from './commands/migrate';
import { runKillCli, runPs } from './commands/ps';
import {
  runSecretsGet,
  runSecretsList,
  runSecretsRemove,
  runSecretsSet,
} from './commands/secrets';
import {
  runServiceRestart,
  runServiceStart,
  runServiceStatus,
  runServiceStop,
  runServiceUnregister,
} from './commands/service';
import { runStart } from './commands/start';

const program = new Command();

program
  .name('lark-agents-bridge')
  .description('Bridge Feishu/Lark messenger with local Codex')
  .version(pkg.version, '-v, --version');

// === process-level commands (work directly on bridge processes) ===

program
  .command('run')
  .description('Run the bridge in the foreground (was `start` in older versions)')
  .option('-c, --config <path>', 'path to config file')
  .option('--skip-check-lark-cli', 'skip lark-cli pre-flight check (auto-install + bind)')
  .action(async (opts: { config?: string; skipCheckLarkCli?: boolean }) => {
    await runStart(opts);
  });

program
  .command('ps')
  .description('List running bridge processes on this machine')
  .action(() => {
    runPs();
  });

program
  .command('kill <target>')
  .description('Kill a running bridge process by short id or list index (SIGTERM, then SIGKILL after 2s). Was `stop <target>` in older versions.')
  .action(async (target: string) => {
    await runKillCli(target);
  });

// === service-level commands (OS-managed daemon: launchd/systemd/schtasks) ===

program
  .command('start')
  .description('Install (if needed) and start the bridge as an OS-managed daemon')
  .option('--skip-check-lark-cli', 'skip lark-cli pre-flight check (auto-install + bind)')
  .action(async (opts: { skipCheckLarkCli?: boolean }) => {
    await runServiceStart(opts);
  });

program
  .command('stop')
  .description('Stop the OS-managed daemon (unload from launchd; plist stays)')
  .action(async () => {
    await runServiceStop();
  });

program
  .command('restart')
  .description('Restart the OS-managed daemon')
  .action(async () => {
    await runServiceRestart();
  });

program
  .command('status')
  .description('Show OS service status (pid, last exit, log paths)')
  .action(async () => {
    await runServiceStatus();
  });

program
  .command('unregister')
  .description('Remove the OS service registration (bootout + delete plist)')
  .action(async () => {
    await runServiceUnregister();
  });

const secrets = program
  .command('secrets')
  .description('Manage the bridge\'s encrypted secret keystore (~/.feishu-codex-bridge/secrets.enc)');

secrets
  .command('get')
  .description('Exec-provider protocol: read JSON request from stdin and write the encrypted local secret response to stdout.')
  .action(async () => {
    await runSecretsGet();
  });

secrets
  .command('set')
  .description('Encrypt and store an App Secret. Prompts for the secret without echoing.')
  .requiredOption('--app-id <id>', 'App ID (e.g. cli_xxxxxxxxxxxx)')
  .action(async (opts: { appId: string }) => {
    await runSecretsSet(opts.appId);
  });

secrets
  .command('list')
  .description('List the IDs of secrets in the encrypted keystore (no secrets shown)')
  .action(async () => {
    await runSecretsList();
  });

secrets
  .command('remove')
  .description('Delete an entry from the encrypted keystore')
  .requiredOption('--app-id <id>', 'App ID to remove')
  .action(async (opts: { appId: string }) => {
    await runSecretsRemove(opts.appId);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

import { describe, expect, it } from 'vitest';

import {
  assessCommand,
  authorizeCommand,
  authorizeTransfer,
  enforceCommandAuthorization,
  enforceTransferAuthorization
} from '../src/core/command-policy';

describe('command-policy', () => {
  describe('基础只读分类', () => {
    it('识别单条明确的只读命令', () => {
      expect(assessCommand('ls -la').risk).toBe('readonly');
    });

    it('complex commands cannot masquerade as readonly commands', () => {
      expect(assessCommand('ls; python mutate.py').risk).toBe('write');
      expect(assessCommand('cat $(echo /etc/passwd)').risk).toBe('write');
      expect(assessCommand('cat file > copy').risk).toBe('write');
      expect(assessCommand('ls & python mutate.py').risk).toBe('write');
    });

    it('compound commands with all-readonly segments are classified as readonly', () => {
      expect(assessCommand('ps aux | grep node').risk).toBe('readonly');
      expect(assessCommand('pwd\nuname -a').risk).toBe('readonly');
      expect(assessCommand('docker ps | grep sub2api').risk).toBe('readonly');
      expect(assessCommand('ls; uname -a').risk).toBe('readonly');
    });

    it('hostname is classified as readonly', () => {
      expect(assessCommand('hostname').risk).toBe('readonly');
      expect(authorizeCommand('auto_readonly', 'hostname').allowed).toBe(true);
    });
  });

  describe('curl 命令分类', () => {
    it('curl defaults to readonly (GET request)', () => {
      expect(assessCommand('curl https://example.com').risk).toBe('readonly');
      expect(assessCommand('curl -s https://example.com/api').risk).toBe('readonly');
      expect(assessCommand('curl -H "Accept: application/json" https://example.com').risk).toBe('readonly');
      expect(authorizeCommand('auto_readonly', 'curl https://example.com').allowed).toBe(true);
    });

    it('curl with write indicators is classified as write', () => {
      expect(assessCommand('curl -X POST https://example.com/api').risk).toBe('write');
      expect(assessCommand('curl -X PUT -d \'{"key":"val"}\' https://example.com').risk).toBe('write');
      expect(assessCommand('curl -d "data" https://example.com').risk).toBe('write');
      expect(assessCommand('curl --data-binary @file https://example.com').risk).toBe('write');
      expect(assessCommand('curl -T upload.txt https://example.com').risk).toBe('write');
      expect(assessCommand('curl --request DELETE https://example.com/api').risk).toBe('write');
      expect(authorizeCommand('auto_readonly', 'curl -X POST https://example.com').allowed).toBe(false);
    });

    it('curl file write flags are classified as write', () => {
      // -o / --output 写入指定本地文件
      expect(assessCommand('curl -o file.txt https://example.com').risk).toBe('write');
      expect(assessCommand('curl --output file.txt https://example.com').risk).toBe('write');
      expect(assessCommand('curl --output=file.txt https://example.com').risk).toBe('write');
      // -O / --remote-name 以 URL 末尾文件名写入
      expect(assessCommand('curl -O https://example.com/file.txt').risk).toBe('write');
      expect(assessCommand('curl --remote-name https://example.com/file.txt').risk).toBe('write');
      // -J / --remote-header-name 配合 -O 使用 Content-Disposition 文件名
      expect(assessCommand('curl -J -O https://example.com/file.txt').risk).toBe('write');
      expect(assessCommand('curl --remote-header-name --remote-name https://example.com/file.txt').risk).toBe('write');
      expect(authorizeCommand('auto_readonly', 'curl -o file.txt https://example.com').allowed).toBe(false);
    });

    it('curl URL query params do not trigger false write detection', () => {
      // URL 查询字符串中的 -d 不应被误判为 curl 标志
      expect(assessCommand('curl https://api.com/search?-debug=1').risk).toBe('readonly');
      expect(assessCommand('curl "https://api.com/search?-d=data"').risk).toBe('readonly');
      expect(assessCommand('curl https://api.com/search?-o=file').risk).toBe('readonly');
    });

    it('curl -o writes file and is not readonly', () => {
      expect(assessCommand('curl -o file.txt https://example.com').risk).toBe('write');
    });

    it('curl -O writes file and is not readonly', () => {
      expect(assessCommand('curl -O https://example.com/file.txt').risk).toBe('write');
    });

    it('curl with URL query params containing -d is still readonly', () => {
      expect(assessCommand('curl https://api.com/search?-debug=1').risk).toBe('readonly');
    });
  });

  describe('docker 命令分类', () => {
    it('docker readonly subcommands include inspect, info, network, volume, container, system', () => {
      const readonlyCommands = [
        'docker inspect my-container',
        'docker info',
        'docker version',
        'docker diff my-container',
        'docker network ls',
        'docker network inspect bridge',
        'docker volume ls',
        'docker volume inspect my-vol',
        'docker container ls',
        'docker container inspect my-container',
        'docker container logs my-container',
        'docker system df',
        'docker system info'
      ];
      for (const command of readonlyCommands) {
        expect(assessCommand(command).risk).toBe('readonly');
        expect(authorizeCommand('auto_readonly', command).allowed).toBe(true);
      }
    });

    it('docker write subcommands remain classified as write', () => {
      expect(assessCommand('docker run -d nginx').risk).toBe('write');
      expect(assessCommand('docker compose up -d').risk).toBe('write');
      expect(assessCommand('docker build -t myimage .').risk).toBe('write');
      expect(assessCommand('docker rm my-container').risk).toBe('write');
      expect(assessCommand('docker pull nginx').risk).toBe('write');
      expect(assessCommand('docker network prune').risk).toBe('write');
      expect(assessCommand('docker volume prune').risk).toBe('write');
      expect(assessCommand('docker system prune').risk).toBe('write');
      expect(assessCommand('docker container prune').risk).toBe('write');
    });
  });

  describe('伪装防护', () => {
    it('environment assignments and executable lookalikes cannot masquerade as readonly commands', () => {
      const commands = ['ls=shadowed python mutate.py', 'cat=x sh /tmp/mutate.sh', 'ps=x ./mutate'];
      for (const command of commands) {
        expect(assessCommand(command).risk).toBe('write');
        expect(authorizeCommand('auto_readonly', command).allowed).toBe(false);
      }
    });

    it('readonly command arguments are not treated as executables', () => {
      const commands = ['grep passwd /etc/passwd', 'grep reboot notes.txt', 'ls shutdown'];
      for (const command of commands) {
        expect(assessCommand(command).risk).toBe('readonly');
        expect(authorizeCommand('auto_readonly', command).allowed).toBe(true);
      }
    });

    it('readonly lookup and search commands do not treat arguments as writes or execution', () => {
      const commands = [
        'grep rm notes.txt',
        'grep mkdir notes.txt',
        'command -v shutdown',
        'command -V reboot'
      ];
      for (const command of commands) {
        expect(assessCommand(command).risk).toBe('readonly');
        expect(authorizeCommand('auto_readonly', command).allowed).toBe(true);
      }
    });

    it('readonly classification requires an unwrapped executable in the original command position', () => {
      const commands = ['FOO=bar ls', 'env ls', 'sudo ls', 'command ls'];
      for (const command of commands) {
        expect(assessCommand(command).risk).toBe('write');
        expect(authorizeCommand('auto_readonly', command).allowed).toBe(false);
      }
    });
  });

  describe('systemctl 命令分类', () => {
    it('systemctl status remains readonly after leading readonly options', () => {
      const commands = [
        'systemctl --no-pager status ssh',
        'systemctl --quiet status sshd',
        'systemctl --host=example.test status ssh'
      ];
      for (const command of commands) {
        expect(assessCommand(command).risk).toBe('readonly');
        expect(authorizeCommand('auto_readonly', command).allowed).toBe(true);
      }
    });

    it('ambiguous readonly-looking commands require approval', () => {
      const commands = [
        'find . -delete',
        'find . -exec /tmp/mutate {} +',
        'date --set=tomorrow',
        'journalctl --rotate',
        'rg --pre mutate pattern',
        'less -o output.log file'
      ];
      for (const command of commands) {
        expect(assessCommand(command).risk).toBe('write');
        expect(authorizeCommand('auto_readonly', command).allowed).toBe(false);
      }
    });

    it('systemctl options do not hide high risk SSH restarts', () => {
      const commands = ['systemctl --no-pager restart ssh', 'systemctl --quiet restart sshd'];
      for (const command of commands) {
        expect(assessCommand(command).risk).toBe('high');
        expect(authorizeCommand('auto_readonly', command).allowed).toBe(false);
      }
    });

    it('systemctl value options cannot hide high risk SSH restarts from trusted sessions', () => {
      const commands = [
        'systemctl --output short restart ssh',
        'systemctl -o short restart ssh',
        'systemctl --lines 20 restart ssh'
      ];
      for (const command of commands) {
        expect(assessCommand(command).risk).toBe('high');
        expect(authorizeCommand('trusted_session', command).allowed).toBe(false);
      }
    });

    it('systemctl options between restart and SSH units cannot bypass trusted-session approval', () => {
      const commands = [
        'systemctl restart --no-block ssh',
        'systemctl restart --job-mode replace ssh',
        'systemctl restart -- ssh'
      ];
      for (const command of commands) {
        expect(assessCommand(command).risk).toBe('high');
        expect(authorizeCommand('trusted_session', command).allowed).toBe(false);
      }
    });
  });

  describe('高危命令', () => {
    it('high risk commands retain their risk in compound syntax', () => {
      expect(assessCommand('rm -rf /; true').risk).toBe('high');
      expect(assessCommand('shutdown -h now && true').risk).toBe('high');
      expect(assessCommand('sudo -n rm -rf /tmp/demo').risk).toBe('high');
      expect(assessCommand('rm -fr /').risk).toBe('high');
      expect(assessCommand('rm -r -f /').risk).toBe('high');
      expect(assessCommand('rm --recursive --force /').risk).toBe('high');
      expect(assessCommand('sudo -- rm -rf /').risk).toBe('high');
      expect(assessCommand('sudo -u root -- rm -rf /').risk).toBe('high');
      expect(assessCommand('FOO=bar rm -rf /').risk).toBe('high');
      expect(assessCommand('sudo FOO=bar rm -rf /').risk).toBe('high');
      expect(assessCommand('command rm -rf /').risk).toBe('high');
      expect(assessCommand('env rm -rf /').risk).toBe('high');
      expect(assessCommand('sudo -D /tmp rm -rf /').risk).toBe('high');
      expect(assessCommand('command shutdown -h now').risk).toBe('high');
      expect(assessCommand('FOO=bar shutdown -h now').risk).toBe('high');
      expect(assessCommand('sudo env reboot').risk).toBe('high');
      expect(assessCommand("bash -c 'rm -rf /'").risk).toBe('high');
    });

    const trustedSessionHighRiskCommands = [
      String.raw`r\m -rf /`,
      String.raw`system\ctl restart ssh`,
      "dash -c 'rm -rf /'",
      'dd of=/dev/sda',
      'poweroff',
      'halt',
      'systemctl poweroff',
      'fdisk /dev/sda',
      'systemctl restart ssh.socket',
      'rm -r /home'
    ];

    for (const command of trustedSessionHighRiskCommands) {
      it(`trusted sessions reject high risk command: ${command}`, () => {
        expect(assessCommand(command).risk).toBe('high');
        expect(authorizeCommand('trusted_session', command).allowed).toBe(false);
        expect(authorizeCommand('ask_every_time', command).allowed).toBe(true);
      });
    }

    it('a trailing unquoted backslash fails closed without throwing', () => {
      const command = 'ls\\';
      expect(() => assessCommand(command)).not.toThrow();
      expect(assessCommand(command).risk).toBe('write');
      expect(authorizeCommand('auto_readonly', command).allowed).toBe(false);
    });

    it('backslashes inside single quotes remain literal', () => {
      const command = String.raw`r'\m' -rf /`;
      expect(assessCommand(command).risk).toBe('write');
      expect(authorizeCommand('trusted_session', command).allowed).toBe(true);
    });

    it('append environment assignments cannot hide high risk commands from trusted sessions', () => {
      const commands = [
        'env FOO+=x rm -rf /',
        'sudo FOO+=x systemctl restart ssh'
      ];
      for (const command of commands) {
        expect(assessCommand(command).risk).toBe('high');
        expect(authorizeCommand('trusted_session', command).allowed).toBe(false);
      }
    });
  });

  describe('边界情况', () => {
    it('deeply wrapped commands require approval without overflowing the parser', () => {
      const deeplyWrapped = 'env '.repeat(10_000) + 'ls';
      expect(() => assessCommand(deeplyWrapped)).not.toThrow();
      expect(assessCommand(deeplyWrapped).risk).toBe('write');
      expect(authorizeCommand('auto_readonly', deeplyWrapped).allowed).toBe(false);
    });

    it('wrapper nesting beyond the policy limit requires approval', () => {
      const deeplyWrapped = 'env '.repeat(33) + 'rm -rf /';
      expect(assessCommand(deeplyWrapped).risk).toBe('write');
      expect(authorizeCommand('auto_readonly', deeplyWrapped).allowed).toBe(false);
    });

    it('overlong commands require approval without throwing', () => {
      const overlongCommand = 'ls ' + 'a'.repeat(40_000);
      expect(() => assessCommand(overlongCommand)).not.toThrow();
      expect(assessCommand(overlongCommand).risk).toBe('write');
      expect(authorizeCommand('auto_readonly', overlongCommand).allowed).toBe(false);
    });

    it('empty commands are treated as write operations', () => {
      expect(assessCommand('   ').risk).toBe('write');
    });
  });

  describe('授权级别', () => {
    it('auto readonly sessions allow only explicit readonly commands', () => {
      expect(authorizeCommand('auto_readonly', 'df -h').allowed).toBe(true);
      expect(authorizeCommand('auto_readonly', 'mkdir /tmp/demo').allowed).toBe(false);
      expect(authorizeCommand('auto_readonly', 'ls && python mutate.py').allowed).toBe(false);
      expect(authorizeCommand('auto_readonly', 'ls & python mutate.py').allowed).toBe(false);
    });

    it('client-approved sessions allow write commands', () => {
      expect(authorizeCommand('ask_every_time', 'mkdir /tmp/demo').allowed).toBe(true);
      expect(authorizeCommand('trusted_session', 'mkdir /tmp/demo').allowed).toBe(true);
    });

    it('authorization levels preserve per-operation approval for high risk commands', () => {
      const command = 'rm -rf /tmp/demo';
      expect(authorizeCommand('trusted_session', command).allowed).toBe(false);
      expect(authorizeCommand('ask_every_time', command).allowed).toBe(true);
      expect(() => enforceCommandAuthorization('trusted_session', command)).toThrow(
        /高危操作仍需逐次审批.*每次询问/
      );
    });

    it('auto readonly sessions allow downloads but deny uploads', () => {
      expect(authorizeTransfer('auto_readonly', 'download').allowed).toBe(true);
      expect(authorizeTransfer('auto_readonly', 'upload').allowed).toBe(false);
      expect(authorizeTransfer('ask_every_time', 'upload').allowed).toBe(true);
    });

    it('auto readonly sessions enforce command authorization', () => {
      expect(() => enforceCommandAuthorization('auto_readonly', 'mkdir /tmp/demo')).toThrow(
        /当前会话为\u201c只读自动\u201d/
      );
      expect(() => enforceCommandAuthorization('auto_readonly', 'df -h')).not.toThrow();
    });

    it('auto readonly sessions enforce transfer authorization', () => {
      expect(() => enforceTransferAuthorization('auto_readonly', 'upload')).toThrow(
        /已拒绝文件上传/
      );
      expect(() => enforceTransferAuthorization('auto_readonly', 'download')).not.toThrow();
    });
  });
});

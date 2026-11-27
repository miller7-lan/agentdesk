#!/usr/bin/python3 -I
# `pc`: inside a native CLI sandbox on VPS2, runs a command on the person's own computer, in this chat's shared
# terminal in AgentDesk (the person sees it run and can step in). Talks to the device's bridge socket, which
# AgentDesk's own connection serves (agentdesk-cli.js pcbridge); nothing else on VPS2 is reachable from here.
#
#   pc '<command>'            run in this chat's terminal (Windows: PowerShell; Mac: zsh); prints the output and
#                             exits with the command's exit code
#   pc --new '<command>'      run in a new terminal (long-running programs such as dev servers; at most 4)
#   pc --ask '<what to do>'   ask the person to take over the terminal (passwords, confirmations); returns when
#                             they hand it back, with what the terminal shows
#   pc --screen               what the terminal shows now
#   pc --timeout 600 '<cmd>'  seconds to wait before stopping the command (default 600)
import json
import os
import socket
import sys

SOCKET = '/run/agentdesk/pc/bridge.sock'


USAGE = '''用法（在用户电脑上执行）:
  pc '<命令>'              在这个单聊的共用终端里运行，输出和退出码返回
  pc --new '<命令>'        在新终端里运行（开发服务器等长时间程序；最多 4 个）
  pc --ask '<请用户做什么>'  请用户接管终端（输密码、确认），交还后返回终端内容
  pc --screen              终端当前内容
  pc --timeout 秒 '<命令>'  超时（默认 600 秒）
'''


def usage():
    sys.stderr.write(USAGE)
    sys.exit(2)


def main(argv):
    request = {'op': 'run', 'chat': os.environ.get('AGENTDESK_CHAT', ''), 'timeout': 600}
    while argv and argv[0].startswith('--'):
        flag = argv.pop(0)
        if flag == '--new':
            request['newTerminal'] = True
        elif flag == '--ask':
            request['op'] = 'ask'
        elif flag == '--screen':
            request['op'] = 'screen'
        elif flag == '--timeout' and argv and argv[0].isdigit():
            request['timeout'] = min(int(argv.pop(0)), 6 * 3600)
        else:
            usage()
    text = ' '.join(argv).strip()
    if request['op'] in ('run', 'ask') and not text:
        usage()
    if request['op'] == 'run':
        request['command'] = text
    elif request['op'] == 'ask':
        request['message'] = text
    if len(text) > 64 * 1024:
        sys.stderr.write('pc: 命令太长（最多 64 KB）\n')
        return 2
    try:
        conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        conn.connect(SOCKET)
    except OSError:
        sys.stderr.write('pc: 用户电脑现在连不上（AgentDesk 没有打开或已断线）。请告诉用户打开 AgentDesk 后再试。\n')
        return 75
    conn.sendall((json.dumps(request, ensure_ascii=False) + '\n').encode('utf-8'))
    buffer = b''
    code = 1
    while True:
        chunk = conn.recv(65536)
        if not chunk:
            break
        buffer += chunk
        while b'\n' in buffer:
            line, buffer = buffer.split(b'\n', 1)
            try:
                message = json.loads(line)
            except ValueError:
                continue
            kind = message.get('type')
            if kind == 'out':
                sys.stdout.write(message.get('data', ''))
                sys.stdout.flush()
            elif kind == 'note':
                sys.stderr.write('pc: ' + message.get('text', '') + '\n')
            elif kind == 'done':
                if message.get('text'):
                    sys.stdout.write(message['text'])
                code = message.get('code', 0)
                if not isinstance(code, int) or code < 0 or code > 255:
                    code = 1
                return code
    sys.stderr.write('pc: 与用户电脑的连接中断。\n')
    return code


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))

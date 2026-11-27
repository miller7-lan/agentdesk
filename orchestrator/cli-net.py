# Connects a native CLI sandbox's network namespace to the internet with slirp4netns (cli-jail.js).
#
# bwrap gives the sandbox its own user namespace and, because it mounts a fresh /dev/pts, a second one nested in
# it; the network namespace belongs to the first, which no process stays in. So the owning user namespace is asked
# of the network namespace itself (ioctl NS_GET_USERNS) and both are handed to slirp4netns by file descriptor.
#
# The slirp4netns used is AgentDesk's copy with set-group-id agentdesk-cli, the group /etc/agentdesk-cli-net.nft
# keeps away from VPS2 itself and private networks. --disable-host-loopback: 10.0.2.2 does not lead to VPS2's
# loopback. fd 3 (from the caller): written when ready; fd 4: slirp4netns ends when the caller's end closes.
import fcntl
import os
import sys

NS_GET_USERNS = 0xB701
SLIRP = '/usr/local/lib/agentdesk/slirp4netns'

pid = sys.argv[1]
if not pid.isdigit():
    sys.exit('invalid pid')
net = os.open(f'/proc/{pid}/ns/net', os.O_RDONLY)
user = fcntl.ioctl(net, NS_GET_USERNS)
os.set_inheritable(net, True)
os.set_inheritable(user, True)
os.execv(SLIRP, ['slirp4netns', '--configure', '--mtu=65520', '--disable-host-loopback', '--ready-fd=3', '--exit-fd=4',
                 f'--userns-path=/proc/self/fd/{user}', '--netns-type=path', f'/proc/self/fd/{net}', 'tap0'])

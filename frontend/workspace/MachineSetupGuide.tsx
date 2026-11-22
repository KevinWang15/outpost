import { useId, type KeyboardEvent } from 'react'
import { ArrowLeft, ArrowRight, Cable, HardDrive, Laptop, Network, Server, SquareTerminal } from 'lucide-react'
import { machineSetupLabels, type Target } from '../../shared/model'

type Kind = Target['kind']
function ConnectionRoute({ kind }: { kind: Kind }) {
  const server = kind !== 'direct'
  const machine = kind !== 'local'
  return (
    <div className="machine-route" aria-hidden="true">
      <span>
        <Laptop />
        Your device
      </span>
      <ArrowRight />
      {server && (
        <span>
          <Server />
          Outpost server
        </span>
      )}
      {server && machine && (kind === 'paired' ? <ArrowLeft /> : <ArrowRight />)}
      {machine && (
        <span>
          <HardDrive />
          Linux machine
        </span>
      )}
    </div>
  )
}

export default function MachineSetupGuide({
  kind,
  localAvailable,
  hosted,
  onSelect,
}: {
  kind: Kind
  localAvailable: boolean
  hosted: boolean
  onSelect: (kind: Kind) => void
}) {
  const id = useId()
  const options: Kind[] = ['ssh', 'direct', 'paired']
  if (localAvailable) options.push('local')
  const methods = {
    ssh: {
      icon: SquareTerminal,
      title: 'Let Outpost connect over SSH',
      when: 'Use SSH when the Outpost server can log in to the Linux machine, even if your own device cannot reach it.',
      route: 'Your device connects to Outpost. The server opens the SSH connection as the Linux user you choose.',
      needs: hosted ? (
        <>
          The SSH host, port and Linux username. The next screen gives you a public key to add to that user’s{' '}
          <code>~/.ssh/authorized_keys</code>.
        </>
      ) : (
        'The SSH host and Linux username. Outpost uses SSH credentials on the server. You can also specify an identity file.'
      ),
      next: (
        <>
          Open <strong>Required software</strong> on the machine page to check the tools available to that user, then
          create a session.
        </>
      ),
    },
    direct: {
      icon: Cable,
      title: 'Connect straight to the machine',
      when: 'Use Direct only when your device can reach the machine over HTTPS, for example on a company VPN. The machine never connects back to Outpost.',
      route:
        'Your device signs in to Outpost, then connects to the machine. Terminal traffic and files travel directly. Server-side Chat is unavailable.',
      needs:
        'An HTTPS address reachable from your device. It must forward WebSocket connections to the Outpost machine service.',
      next: (
        <>
          Choose <strong>Show offline enrollment</strong>. On the machine, run{' '}
          <code>outpost-terminal pair --direct</code>, paste the settings, then run{' '}
          <code>outpost-terminal connect</code>.
        </>
      ),
    },
    paired: {
      icon: Network,
      title: 'Reach a machine behind NAT',
      when: 'Use the relay for a home or office machine behind a router, or whenever your device cannot reliably reach the machine.',
      route:
        'Your device and machine both connect to Outpost. If you configure a reachable HTTPS address, your device tries that direct route first.',
      needs:
        'The machine must be able to make an outbound connection to your Outpost server. No inbound port is needed for the relay.',
      next: (
        <>
          Choose <strong>Generate pairing code</strong>. Run the pairing command shown on the machine page, enter the
          code on the machine, then run <code>outpost-terminal connect</code>.
        </>
      ),
    },
    local: {
      icon: HardDrive,
      title: 'Run sessions on the Outpost server',
      when: 'Choose this when your projects and coding tools live on the same Linux host that runs Outpost.',
      route: 'Your device connects to Outpost. Sessions run there, with no SSH login or pairing step.',
      needs:
        'The account running Outpost needs access to your project directories and the coding tools you want to use.',
      next: (
        <>
          Check <strong>Required software</strong> on the machine page, then choose <strong>New session</strong> and
          select a project directory on this server.
        </>
      ),
    },
  }

  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = {
      ArrowRight: (index + 1) % options.length,
      ArrowDown: (index + 1) % options.length,
      ArrowLeft: (index + options.length - 1) % options.length,
      ArrowUp: (index + options.length - 1) % options.length,
      Home: 0,
      End: options.length - 1,
    }[event.key]
    if (next === undefined) return
    event.preventDefault()
    onSelect(options[next])
    document.getElementById(id + options[next])?.focus()
  }

  return (
    <div className="machine-guide">
      <div className="machine-methods" role="tablist" aria-label="Connection method">
        {options.map((method, index) => {
          const Icon = methods[method].icon
          return (
            <button
              key={method}
              id={id + method}
              type="button"
              role="tab"
              aria-selected={kind === method}
              aria-controls={id + '-panel-' + method}
              tabIndex={kind === method ? 0 : -1}
              onClick={() => onSelect(method)}
              onKeyDown={event => navigate(event, index)}
            >
              <Icon size={17} />
              {machineSetupLabels[method]}
            </button>
          )
        })}
      </div>
      {options.map(method => (
        <section
          key={method}
          role="tabpanel"
          hidden={kind !== method}
          id={id + '-panel-' + method}
          aria-labelledby={id + method}
          tabIndex={0}
          className="machine-guide-panel"
        >
          <h3>{methods[method].title}</h3>
          <p>{methods[method].when}</p>
          <div className="machine-path">
            <ConnectionRoute kind={method} />
            <p>{methods[method].route}</p>
          </div>
          <dl>
            <div>
              <dt>What you need</dt>
              <dd>{methods[method].needs}</dd>
            </div>
            <div>
              <dt>After adding</dt>
              <dd>{methods[method].next}</dd>
            </div>
          </dl>
        </section>
      ))}
    </div>
  )
}

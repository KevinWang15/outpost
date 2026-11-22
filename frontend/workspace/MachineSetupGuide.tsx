import { useId, useRef, type KeyboardEvent } from 'react'
import { ArrowLeft, ArrowRight, Cable, HardDrive, Laptop, Server, SquareTerminal } from 'lucide-react'
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
  type Method = 'ssh' | 'connector' | 'local'
  const connector = kind === 'direct' || kind === 'paired'
  const method = connector ? 'connector' : kind
  const policy = useRef<'direct' | 'paired'>(kind === 'paired' ? 'paired' : 'direct')
  const options: Method[] = localAvailable ? ['ssh', 'connector', 'local'] : ['ssh', 'connector']
  const tabs = {
    ssh: { label: machineSetupLabels.ssh, icon: SquareTerminal },
    connector: { label: 'Install the connector', icon: Cable },
    local: { label: machineSetupLabels.local, icon: HardDrive },
  }
  const select = (value: Method) => onSelect(value === 'connector' ? policy.current : value)
  const methods = {
    ssh: {
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
      title: 'Connect straight to the machine',
      when: 'Use Direct only when your device can reach the machine over HTTPS, for example on a company VPN. The connector opens no outbound connection.',
      route:
        'Your device obtains permission from Outpost and opens the connection to the machine. Terminal traffic and files travel directly. Server-side Chat is unavailable.',
      needs: 'A device-reachable HTTPS address that forwards requests and WebSockets to the machine service.',
      next: (
        <>
          Choose <strong>Get install command</strong>.{' '}
          {hosted
            ? 'Run it on the machine, or transfer the offline kit for restricted networks.'
            : 'Download the offline kit on this computer and transfer it to the machine.'}
        </>
      ),
    },
    paired: {
      title: 'Reach a machine behind NAT',
      when: 'Use the relay for a home or office machine behind a router, or whenever your device cannot reliably reach the machine.',
      route:
        'Your device and machine both connect to Outpost. If you configure a reachable HTTPS address, your device tries that direct route first.',
      needs: hosted
        ? 'The machine must be able to reach this Outpost server. No inbound port is needed for relay.'
        : 'This deployment accepts only loopback connections. Forward the same loopback port on the machine to this server through a trusted tunnel. Anyone who can use that port can access your local workspace. For a public relay, use a hosted deployment.',
      next: (
        <>
          Choose <strong>Get install command</strong> on the machine page. Paste it into a Linux terminal within five
          minutes to install, pair and start the connector.
        </>
      ),
    },
    local: {
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
    select(options[next])
    document.getElementById(id + options[next])?.focus()
  }

  return (
    <div className="machine-guide">
      <div className="machine-methods" role="tablist" aria-label="Connection method">
        {options.map((option, index) => {
          const { icon: Icon, label } = tabs[option]
          return (
            <button
              key={option}
              id={id + option}
              type="button"
              role="tab"
              aria-selected={option === method}
              aria-controls={id + '-panel'}
              tabIndex={option === method ? 0 : -1}
              onClick={() => select(option)}
              onKeyDown={event => navigate(event, index)}
            >
              <Icon size={17} />
              {label}
            </button>
          )
        })}
      </div>
      <section
        role="tabpanel"
        id={id + '-panel'}
        aria-labelledby={id + method}
        tabIndex={0}
        className="machine-guide-panel"
      >
        {connector && (
          <fieldset className="field machine-policy">
            <legend className="label">May this machine maintain an outbound connection to Outpost?</legend>
            <div className="toggle-group">
              {(['direct', 'paired'] as const).map(option => (
                <label key={option} className="toggle">
                  <input
                    type="radio"
                    name="connector-policy"
                    checked={kind === option}
                    onChange={() => {
                      policy.current = option
                      onSelect(option)
                    }}
                  />
                  {machineSetupLabels[option]}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <h3>{methods[kind].title}</h3>
        <p>{methods[kind].when}</p>
        <div className="machine-path">
          <ConnectionRoute kind={kind} />
          <p>{methods[kind].route}</p>
        </div>
        <dl>
          <div>
            <dt>What you need</dt>
            <dd>{methods[kind].needs}</dd>
          </div>
          <div>
            <dt>After adding</dt>
            <dd>{methods[kind].next}</dd>
          </div>
        </dl>
      </section>
    </div>
  )
}

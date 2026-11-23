import { useId, type KeyboardEvent } from 'react'
import { ArrowLeft, ArrowRight, Cable, HardDrive, Laptop, Server, SquareTerminal } from 'lucide-react'
import { machineSetupLabels, type Target } from '../../shared/model'

type Kind = Target['kind']

export default function MachineSetupGuide({
  kind,
  localAvailable,
  hosted,
  onSelect,
  onLocal,
}: {
  kind: Kind
  localAvailable: boolean
  hosted: boolean
  onSelect: (kind: Kind) => void
  onLocal: () => void
}) {
  const id = useId()
  const options = ['ssh', 'outbound'] as const
  const tabs = {
    ssh: { label: machineSetupLabels.ssh, icon: SquareTerminal },
    outbound: { label: machineSetupLabels.outbound, icon: Cable },
  }
  const method = kind === 'outbound' ? kind : 'ssh'
  const description =
    method === 'ssh'
      ? {
          title: 'Outpost can SSH to this machine',
          when: hosted
            ? 'The hosted server opens SSH with your account key. A bastion must be reachable from that server.'
            : 'This computer opens SSH with your OpenSSH configuration, keys and jump hosts.',
          needs: 'The Linux execution account, host and SSH port. This machine never connects back to Outpost.',
          next: 'Outpost checks installed software and sets up the machine service over SSH. Coding tools already on the machine are detected automatically, and you can set up more from the machine page.',
        }
      : {
          title: 'The machine can reach Outpost',
          when: 'Choose this when Outpost cannot open SSH to the machine. Running the setup command explicitly allows a persistent outbound connection.',
          needs: hosted
            ? 'A shell on the Linux machine and access to this Outpost server.'
            : 'A shell on the Linux machine and a reachable address for this instance. A remote machine cannot reach the default workstation loopback address.',
          next: 'Run the one-time command on the machine as the user who will own its sessions. The service reconnects to this Outpost instance after logout or reboot.',
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
              onClick={() => onSelect(option)}
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
        <h3>{description.title}</h3>
        <p>{description.when}</p>
        <div className="machine-path">
          <div className="machine-route" aria-hidden="true">
            <span>
              <Laptop />
              Your browser
            </span>
            <ArrowRight />
            <span>
              <Server />
              {hosted ? 'Hosted Outpost' : 'Local Outpost'}
            </span>
            {method === 'outbound' ? <ArrowLeft /> : <ArrowRight />}
            <span>
              <HardDrive />
              Linux machine
            </span>
          </div>
        </div>
        <dl>
          <div>
            <dt>What you need</dt>
            <dd>{description.needs}</dd>
          </div>
          <div>
            <dt>After adding</dt>
            <dd>{description.next}</dd>
          </div>
        </dl>
      </section>
      {localAvailable && (
        <button type="button" className="button" onClick={onLocal}>
          Run sessions on this computer
        </button>
      )}
    </div>
  )
}

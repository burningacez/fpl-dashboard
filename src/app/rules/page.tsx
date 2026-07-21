import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Rules & Info' };

const LINKS = {
  monzo: 'https://monzo.me/barryevans75',
  paypal: 'https://www.paypal.com/paypalme/bevans194',
  whatsapp: 'https://chat.whatsapp.com/Dgk93EIvjj35J4BVMdG0M5',
  fplLeague: 'https://fantasy.premierleague.com/leagues/619028/standings/c',
  livefpl: 'https://livefpl.net/leagues/619028',
};

function Section({ icon, title, children }: { icon: string; title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-edge bg-surface p-5">
      <h2 className="mb-3 flex items-center gap-2 text-lg font-extrabold">
        <span aria-hidden>{icon}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

export default function RulesPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-8 pb-12">
      <h1 className="mb-6 text-2xl font-extrabold tracking-tight sm:text-3xl">Rules &amp; Info</h1>

      <div className="flex flex-col gap-4">
        <Section icon="💷" title="Payment">
          <p className="mb-3 text-body">
            Entry fee and weekly loser fines should be paid promptly via Monzo or PayPal.
          </p>
          <div className="flex flex-wrap gap-2">
            <a href={LINKS.monzo} className="rounded-md bg-accent px-4 py-2 font-bold text-accent-fg" target="_blank" rel="noopener noreferrer">
              Pay via Monzo
            </a>
            <a href={LINKS.paypal} className="rounded-md border border-edge px-4 py-2 font-bold" target="_blank" rel="noopener noreferrer">
              Pay via PayPal
            </a>
          </div>
        </Section>

        <Section icon="🏆" title="Prizes">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <h3 className="mb-1 font-bold text-accent">League</h3>
              <ul className="text-body">
                <li className="flex justify-between"><span>1st</span><span className="font-bold">£320</span></li>
                <li className="flex justify-between"><span>2nd</span><span className="font-bold">£200</span></li>
                <li className="flex justify-between"><span>3rd</span><span className="font-bold">£120</span></li>
              </ul>
            </div>
            <div>
              <h3 className="mb-1 font-bold text-accent">Cup</h3>
              <ul className="text-body">
                <li className="flex justify-between"><span>Winner</span><span className="font-bold">£150</span></li>
              </ul>
            </div>
            <div>
              <h3 className="mb-1 font-bold text-accent">MotM</h3>
              <ul className="text-body">
                <li className="flex justify-between"><span>Per period</span><span className="font-bold">£30</span></li>
                <li className="flex justify-between"><span>Total (9)</span><span className="font-bold">£270</span></li>
              </ul>
            </div>
          </div>
        </Section>

        <Section icon="⭐" title="Manager of the Month">
          <p className="mb-3 text-body">
            The season is divided into 9 periods. The manager with the highest net score (points minus transfer
            costs) in each period wins.
          </p>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
            {[
              ['P1', 'GW 1-5'],
              ['P2', 'GW 6-9'],
              ['P3', 'GW 10-13'],
              ['P4', 'GW 14-17'],
              ['P5', 'GW 18-21'],
              ['P6', 'GW 22-25'],
              ['P7', 'GW 26-29'],
              ['P8', 'GW 30-33'],
              ['P9', 'GW 34-38'],
            ].map(([p, gw]) => (
              <div key={p} className="rounded-lg border border-edge bg-raised px-2 py-1.5 text-center">
                <div className="font-bold text-accent">{p}</div>
                <div className="text-xs text-muted">{gw}</div>
              </div>
            ))}
          </div>
        </Section>

        <Section icon="⚖️" title="Tiebreakers">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <h3 className="mb-1 font-bold">Weekly Loser</h3>
              <ol className="list-decimal pl-5 text-sm text-body">
                <li>Fewest transfers that gameweek</li>
                <li>Coin flip</li>
              </ol>
            </div>
            <div>
              <h3 className="mb-1 font-bold">Manager of the Month</h3>
              <ol className="list-decimal pl-5 text-sm text-body">
                <li>Highest net score for the period</li>
                <li>Fewest transfers during the period</li>
                <li>Highest single gameweek score</li>
                <li>Highest lowest score (best worst GW)</li>
                <li>Coin flip</li>
              </ol>
            </div>
            <div>
              <h3 className="mb-1 font-bold">Final Standings</h3>
              <ol className="list-decimal pl-5 text-sm text-body">
                <li>Fewest transfers over the season</li>
                <li>Most MotM wins</li>
                <li>Fewest weekly losses</li>
                <li>Highest single GW score</li>
                <li>Highest lowest score</li>
                <li>Coin flip</li>
              </ol>
            </div>
          </div>
        </Section>

        <Section icon="👤" title="Logging in">
          <p className="text-body">
            Tap the <span className="font-bold text-me">👤 Who are you?</span> button in the top bar and pick your
            team (or enter your FPL team ID). You&apos;ll then be highlighted in every table, and you can use the
            Team Planner. It&apos;s a one-time choice — each team can be claimed by one person, and once you&apos;ve
            picked, switching needs a code from the admin. Just visiting? Choose &ldquo;just visiting&rdquo; and you
            can claim a team later.
          </p>
        </Section>

        <Section icon="🔗" title="Useful Links">
          <div className="flex flex-wrap gap-2">
            <a href={LINKS.whatsapp} className="rounded-md border border-edge px-4 py-2 font-semibold" target="_blank" rel="noopener noreferrer">
              WhatsApp
            </a>
            <a href={LINKS.fplLeague} className="rounded-md border border-edge px-4 py-2 font-semibold" target="_blank" rel="noopener noreferrer">
              FPL League
            </a>
            <a href={LINKS.livefpl} className="rounded-md border border-edge px-4 py-2 font-semibold" target="_blank" rel="noopener noreferrer">
              FPL Live
            </a>
          </div>
        </Section>
      </div>
    </main>
  );
}

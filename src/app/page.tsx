import { HomeTitle } from '@/components/layout/HomeTitle';
import { SeasonHeading } from '@/components/layout/SeasonHeading';
import { HomeCards } from '@/components/home/HomeCards';

export default function HomePage() {
  return (
    <main className="mx-auto max-w-6xl px-4 pb-16">
      <div className="relative py-12 text-center sm:py-16">
        {/* Soft amber glow behind the title. */}
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 h-48 w-full max-w-xl -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent-soft blur-3xl"
        />
        <p className="relative mb-3 text-[11px] font-bold uppercase tracking-[0.35em] text-faint">
          Barry&apos;s Fantasy Premier League
        </p>
        <HomeTitle />
        <div className="relative">
          <SeasonHeading />
        </div>
        <div aria-hidden className="relative mx-auto mt-6 h-px w-24 bg-gradient-to-r from-transparent via-accent to-transparent" />
      </div>

      <HomeCards />
    </main>
  );
}

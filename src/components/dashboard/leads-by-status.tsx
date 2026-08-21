import Link from 'next/link'
import { cn } from '@/lib/utils'
import { LEAD_STATUS_LIST } from '@/lib/leads/status'
import type { LeadStatusCounts } from '@/lib/dashboard/queries'

interface LeadsByStatusProps {
  counts: LeadStatusCounts | null
  loading: boolean
}

/**
 * "Leads by status" — a compact breakdown of contacts across the six
 * lead statuses the smart reader assigns. Each tile links to the
 * Contacts list (the human can then filter there).
 */
export function LeadsByStatus({ counts, loading }: LeadsByStatusProps) {
  const total = counts
    ? LEAD_STATUS_LIST.reduce((sum, m) => sum + (counts[m.value] ?? 0), 0)
    : 0

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-foreground">Leads by status</p>
        {!loading && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {total.toLocaleString()} total
          </span>
        )}
      </div>

      {loading || !counts ? (
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {LEAD_STATUS_LIST.map((m) => (
            <div
              key={m.value}
              className="h-16 animate-pulse rounded-lg border border-border bg-muted/40"
            />
          ))}
        </div>
      ) : (
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {LEAD_STATUS_LIST.map((m) => (
            <Link
              key={m.value}
              href="/contacts"
              className="flex flex-col gap-1 rounded-lg border border-border bg-background/40 p-3 transition-colors hover:bg-muted/50"
            >
              <span className="flex items-center gap-1.5">
                <span className={cn('size-2 shrink-0 rounded-full', m.dotClass)} />
                <span className="truncate text-xs text-muted-foreground">
                  {m.label}
                </span>
              </span>
              <span className="text-xl font-bold tabular-nums text-foreground">
                {(counts[m.value] ?? 0).toLocaleString()}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

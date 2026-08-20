// ============================================================
// Lead-status vocabulary + display metadata.
//
// Framework-agnostic (no server-only or React imports) so it can be
// shared by the server-side classifier, the cron route, and the
// client UI (badges, filter, override dropdown) alike.
// ============================================================

/**
 * The controlled vocabulary for a contact's lead status. Mirrors the
 * CHECK constraint on `contacts.lead_status` (migration 031). Order is
 * the natural pipeline order and is what the UI renders filters/legends
 * in.
 */
export const LEAD_STATUS_VALUES = [
  'new',
  'interested',
  'need_time',
  'pending',
  'not_interested',
  'no_reply',
] as const

export type LeadStatus = (typeof LEAD_STATUS_VALUES)[number]

/** Who last set the status. `ai` = the classifier; `manual` = a human
 *  override, which the classifier will not clobber except on a strong
 *  new signal. */
export type LeadStatusSource = 'ai' | 'manual'

export function isLeadStatus(v: unknown): v is LeadStatus {
  return typeof v === 'string' && (LEAD_STATUS_VALUES as readonly string[]).includes(v)
}

/**
 * "Strong" statuses carry an explicit customer signal (a clear yes or a
 * clear no). The classifier is only allowed to overwrite a human
 * (`manual`) status when the new read is one of these — a soft/ambient
 * read (pending / need_time / no_reply / back to new) never overrides a
 * person's deliberate choice.
 */
export function isStrongStatus(status: LeadStatus): boolean {
  return status === 'interested' || status === 'not_interested'
}

export interface LeadStatusMeta {
  value: LeadStatus
  label: string
  /** Tailwind classes for the badge — filled tint + readable text in
   *  both light and dark. */
  badgeClass: string
  /** Solid dot colour for legends / compact chips. */
  dotClass: string
}

/**
 * Per-status display metadata. Colours follow the brief:
 * green = Interested, amber = Need time, blue = Pending,
 * grey = Not interested, red = No reply, neutral = New.
 */
export const LEAD_STATUS_META: Record<LeadStatus, LeadStatusMeta> = {
  new: {
    value: 'new',
    label: 'New',
    badgeClass:
      'border border-border bg-transparent text-muted-foreground',
    dotClass: 'bg-muted-foreground',
  },
  interested: {
    value: 'interested',
    label: 'Interested',
    badgeClass:
      'bg-green-500/15 text-green-700 dark:text-green-400',
    dotClass: 'bg-green-500',
  },
  need_time: {
    value: 'need_time',
    label: 'Need time',
    badgeClass:
      'bg-amber-500/15 text-amber-700 dark:text-amber-400',
    dotClass: 'bg-amber-500',
  },
  pending: {
    value: 'pending',
    label: 'Pending',
    badgeClass:
      'bg-blue-500/15 text-blue-700 dark:text-blue-400',
    dotClass: 'bg-blue-500',
  },
  not_interested: {
    value: 'not_interested',
    label: 'Not interested',
    badgeClass:
      'bg-zinc-500/20 text-zinc-700 dark:text-zinc-300',
    dotClass: 'bg-zinc-500',
  },
  no_reply: {
    value: 'no_reply',
    label: 'No reply',
    badgeClass:
      'bg-red-500/15 text-red-700 dark:text-red-400',
    dotClass: 'bg-red-500',
  },
}

export function leadStatusLabel(status: string | null | undefined): string {
  return isLeadStatus(status) ? LEAD_STATUS_META[status].label : LEAD_STATUS_META.new.label
}

/** Ordered list for legends, filters, and dropdowns. */
export const LEAD_STATUS_LIST: LeadStatusMeta[] = LEAD_STATUS_VALUES.map(
  (v) => LEAD_STATUS_META[v],
)

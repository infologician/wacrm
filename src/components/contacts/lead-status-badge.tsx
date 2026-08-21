import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { LEAD_STATUS_META, isLeadStatus } from '@/lib/leads/status'

interface LeadStatusBadgeProps {
  status: string | null | undefined
  className?: string
  /** Optional model reason, surfaced as a native tooltip on hover. */
  reason?: string | null
}

/**
 * Small colored badge for a contact's lead status. Falls back to "New"
 * for any missing/unknown value so the column never renders empty.
 */
export function LeadStatusBadge({ status, className, reason }: LeadStatusBadgeProps) {
  const meta = isLeadStatus(status) ? LEAD_STATUS_META[status] : LEAD_STATUS_META.new
  return (
    <Badge
      variant="ghost"
      className={cn(meta.badgeClass, className)}
      title={reason || undefined}
    >
      <span className={cn('size-1.5 shrink-0 rounded-full', meta.dotClass)} />
      {meta.label}
    </Badge>
  )
}

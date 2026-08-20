'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { LEAD_STATUS_LIST, LEAD_STATUS_META, type LeadStatus } from '@/lib/leads/status'

interface LeadStatusSelectProps {
  contactId: string
  value: string | null | undefined
  /** Called with the new status after a successful write, so the parent
   *  can update its local copy without a full refetch. */
  onChanged?: (status: LeadStatus) => void
  /** When false the control is read-only (renders disabled). */
  canEdit?: boolean
  size?: 'sm' | 'default'
  className?: string
}

/**
 * Human override for a contact's lead status. Writing here stamps
 * `lead_status_source = 'manual'`, which the AI classifier will not
 * overwrite except on a strong new signal.
 */
export function LeadStatusSelect({
  contactId,
  value,
  onChanged,
  canEdit = true,
  size = 'sm',
  className,
}: LeadStatusSelectProps) {
  const [saving, setSaving] = useState(false)
  const current = (value as LeadStatus) ?? 'new'

  async function handleChange(next: LeadStatus) {
    if (next === current) return
    setSaving(true)
    const supabase = createClient()
    const { error } = await supabase
      .from('contacts')
      .update({
        lead_status: next,
        lead_status_source: 'manual',
        lead_status_updated_at: new Date().toISOString(),
        lead_status_reason: 'Set manually',
      })
      .eq('id', contactId)
    setSaving(false)
    if (error) {
      toast.error('Failed to update lead status')
      return
    }
    toast.success(`Lead status set to "${LEAD_STATUS_META[next].label}"`)
    onChanged?.(next)
  }

  return (
    <Select
      value={current}
      onValueChange={(v) => handleChange(v as LeadStatus)}
      disabled={!canEdit || saving}
    >
      <SelectTrigger size={size} className={cn('gap-1.5', className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {LEAD_STATUS_LIST.map((meta) => (
          <SelectItem key={meta.value} value={meta.value}>
            <span className={cn('size-2 shrink-0 rounded-full', meta.dotClass)} />
            {meta.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

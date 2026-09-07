import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * Click-to-WhatsApp ad attribution.
 *
 * Meta attaches a `referral` object to the FIRST inbound message of a
 * conversation that began from a Click-to-WhatsApp ad. It carries the ad id
 * (`source_id`), the ad's headline and body copy, and the click id. Meta does
 * not send it again on later messages, so it has to be captured the moment it
 * arrives or the attribution is lost for good.
 *
 * The raw facts are stamped on the contact. One row per ad is kept in
 * `ad_campaigns`, where a human names the campaign once; every lead from that
 * ad reads its name from that single row, so renaming a campaign never means
 * rewriting contact rows.
 */

export interface WhatsAppReferral {
  source_id?: string
  source_type?: string
  source_url?: string
  headline?: string
  body?: string
  ctwa_clid?: string
}

let _client: SupabaseClient | null = null

function admin(): SupabaseClient {
  if (!_client) {
    _client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _client
}

export async function captureAdReferral(
  referral: WhatsAppReferral | undefined | null,
  contactId: string,
  accountId: string
): Promise<void> {
  try {
    const adId = referral?.source_id?.trim()
    if (!adId) return

    const headline = referral?.headline?.trim() || null
    const sourceType = referral?.source_type?.trim() || null
    const clid = referral?.ctwa_clid?.trim() || null
    const now = new Date().toISOString()

    const db = admin()

    // One row per ad. `campaign_name` is set by a person in the CRM, so it is
    // deliberately absent from this payload and can never be clobbered here.
    const { error: campaignError } = await db.from('ad_campaigns').upsert(
      {
        ad_id: adId,
        account_id: accountId,
        ad_headline: headline,
        source_type: sourceType,
        last_seen_at: now,
        updated_at: now,
      },
      { onConflict: 'ad_id,account_id' }
    )
    if (campaignError) {
      console.error('[referral] ad_campaigns upsert failed:', campaignError)
    }

    // First touch wins: `.is('ad_id', null)` means a lead who later clicks a
    // second ad stays credited to the ad that originally brought them in.
    const { error: contactError } = await db
      .from('contacts')
      .update({
        ad_id: adId,
        ad_headline: headline,
        ad_source_type: sourceType,
        ctwa_clid: clid,
        referral_at: now,
      })
      .eq('id', contactId)
      .is('ad_id', null)
    if (contactError) {
      console.error('[referral] contact attribution failed:', contactError)
    }
  } catch (err) {
    // Attribution must never take a webhook down.
    console.error('[referral] unexpected error:', err)
  }
}

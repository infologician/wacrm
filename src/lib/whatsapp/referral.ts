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
 * `ad_campaigns`, and the campaign NAME is resolved once per ad from the Meta
 * Marketing API, so the CRM shows the same campaign name you see in Ads
 * Manager. Renaming a campaign updates every lead from that ad through a
 * database trigger, so contact rows are never rewritten by hand.
 *
 * Resolving the name needs META_ADS_ACCESS_TOKEN (a token with `ads_read`).
 * Without it everything else still works and the ad's headline is shown
 * instead, so attribution is never blocked on the token being present.
 */

const GRAPH_VERSION = 'v21.0'

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

/**
 * Ask Meta what campaign an ad belongs to. Returns null on any failure - a
 * missing token, a revoked token, a deleted ad - because a readable campaign
 * name is a nicety and must never cost us the attribution itself.
 */
async function fetchCampaignName(adId: string): Promise<string | null> {
  const token = process.env.META_ADS_ACCESS_TOKEN
  if (!token) return null

  try {
    const url =
      `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(adId)}` +
      `?fields=campaign{name}&access_token=${encodeURIComponent(token)}`

    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) {
      console.error('[referral] campaign lookup failed:', adId, res.status)
      return null
    }

    const json = (await res.json()) as { campaign?: { name?: string } }
    return json?.campaign?.name?.trim() || null
  } catch (err) {
    console.error('[referral] campaign lookup error:', adId, err)
    return null
  }
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

    // Look the campaign name up once per ad, not once per lead.
    const { data: existing } = await db
      .from('ad_campaigns')
      .select('campaign_name')
      .eq('ad_id', adId)
      .eq('account_id', accountId)
      .maybeSingle()

    const campaignName =
      existing?.campaign_name?.trim() || (await fetchCampaignName(adId))

    // A name typed by a person in the CRM is never clobbered, because it is
    // read back above and passed through unchanged.
    const { error: campaignError } = await db.from('ad_campaigns').upsert(
      {
        ad_id: adId,
        account_id: accountId,
        campaign_name: campaignName,
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

    // First touch wins, with one exception: attribution that was *inferred*
    // from a lead's opening message is a guess, so a confirmed referral from
    // Meta may replace it. Confirmed attribution is never overwritten, so a
    // lead who later clicks a second ad stays credited to the first.
    const { error: contactError } = await db
      .from('contacts')
      .update({
        ad_id: adId,
        ad_headline: headline,
        ad_source_type: sourceType,
        ctwa_clid: clid,
        referral_at: now,
        ad_attribution_method: 'meta_referral',
      })
      .eq('id', contactId)
      .or('ad_id.is.null,ad_attribution_method.eq.inferred_first_message')
    if (contactError) {
      console.error('[referral] contact attribution failed:', contactError)
    }
  } catch (err) {
    // Attribution must never take a webhook down.
    console.error('[referral] unexpected error:', err)
  }
}

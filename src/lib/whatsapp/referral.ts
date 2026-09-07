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
 * The referral does NOT carry the campaign name, only the ad id, so the name
 * shown in Ads Manager has to be read back from the Marketing API. That needs
 * a token with `ads_read`: we try META_ADS_ACCESS_TOKEN first and otherwise
 * fall back to the account's own WhatsApp token, which is often a system-user
 * token that already carries the permission. If neither works we keep the ad's
 * headline as a stand-in, so attribution itself is never blocked on a token.
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
 * Ask Meta which campaign an ad belongs to. Returns null on any failure and
 * logs Meta's own error text, which is what tells us whether a token simply
 * lacks `ads_read` rather than being wrong in some other way.
 */
async function fetchCampaignName(
  adId: string,
  fallbackToken?: string | null
): Promise<string | null> {
  const token = process.env.META_ADS_ACCESS_TOKEN || fallbackToken
  if (!token) return null

  try {
    const url =
      `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(adId)}` +
      `?fields=campaign{name}&access_token=${encodeURIComponent(token)}`

    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    const json = (await res.json()) as {
      campaign?: { name?: string }
      error?: { message?: string; code?: number }
    }

    if (!res.ok || json?.error) {
      console.error(
        '[referral] campaign lookup failed:',
        adId,
        res.status,
        json?.error?.code,
        json?.error?.message
      )
      return null
    }

    return json?.campaign?.name?.trim() || null
  } catch (err) {
    console.error('[referral] campaign lookup error:', adId, err)
    return null
  }
}

/**
 * Fill in campaign names for ads that do not have one yet.
 *
 * Referrals only arrive on a conversation's first message, so without this a
 * newly working token would not backfill the ads already captured. Running it
 * on ordinary inbound traffic (throttled per account) means names appear on
 * their own shortly after a token starts working, rather than waiting for the
 * next brand new ad lead.
 */
const lastSweepAt = new Map<string, number>()
const SWEEP_INTERVAL_MS = 5 * 60 * 1000

export async function resolvePendingCampaignNames(
  accountId: string,
  accessToken?: string | null
): Promise<void> {
  try {
    if (!process.env.META_ADS_ACCESS_TOKEN && !accessToken) return

    const last = lastSweepAt.get(accountId) ?? 0
    if (Date.now() - last < SWEEP_INTERVAL_MS) return
    lastSweepAt.set(accountId, Date.now())

    const db = admin()
    const { data: pending } = await db
      .from('ad_campaigns')
      .select('ad_id')
      .eq('account_id', accountId)
      .is('campaign_name', null)
      .limit(10)

    if (!pending?.length) return

    for (const row of pending) {
      const name = await fetchCampaignName(row.ad_id, accessToken)
      if (!name) continue

      // The trigger on ad_campaigns pushes this out to every contact that
      // came from this ad, so one update relabels all of their leads.
      await db
        .from('ad_campaigns')
        .update({ campaign_name: name, updated_at: new Date().toISOString() })
        .eq('ad_id', row.ad_id)
        .eq('account_id', accountId)
    }
  } catch (err) {
    console.error('[referral] campaign sweep failed:', err)
  }
}

export async function captureAdReferral(
  referral: WhatsAppReferral | undefined | null,
  contactId: string,
  accountId: string,
  accessToken?: string | null
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
      existing?.campaign_name?.trim() ||
      (await fetchCampaignName(adId, accessToken))

    // A name already stored — whether fetched from Meta or typed by a person
    // in the CRM — is read back above and passed through, never clobbered.
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

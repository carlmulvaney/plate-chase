import { createClient } from '@/lib/supabase/server'
import { formatTarget } from '@/lib/plate'

/**
 * TEMPORARY. Claims that counted because nobody objected in time, rather than
 * because anyone approved them.
 *
 * This is a placeholder for a filter. The claims table (submit-path.md §9)
 * will list every claim with filters on status and player, and "auto-approved"
 * is one of those filters — at which point this component is deleted rather
 * than maintained. It exists now only because the distinction between
 * "verified" and "unobjected" should be visible from the day auto-approval
 * started counting, not from the day a table screen gets built.
 *
 * Not on the review screen either way: there is nothing to decide here, and a
 * queue is for things that need deciding.
 */
export async function AutoApproved({ playerId }: { playerId: string }) {
  const supabase = await createClient()
  const { data } = await supabase
    .from('v_auto_approved')
    .select('id, number, plate, settled_at')
    .eq('player_id', playerId)
    .order('number', { ascending: false })
    .limit(10)

  if (!data || data.length === 0) return null

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">Counted unobjected</h2>
      <p className="text-xs text-neutral-500">
        Nobody reviewed these before the window closed, so they count — but no
        one checked them.
      </p>
      <ul className="flex flex-col gap-2">
        {data.map((claim) => (
          <li
            key={claim.id}
            className="flex items-baseline justify-between gap-3 rounded-lg border border-neutral-300 p-3 text-sm dark:border-neutral-700"
          >
            <span>
              {formatTarget(claim.number)}{' '}
              <span className="font-mono text-neutral-500">{claim.plate}</span>
            </span>
            <span className="shrink-0 text-xs text-neutral-500">
              {claim.settled_at && new Date(claim.settled_at).toLocaleDateString()}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

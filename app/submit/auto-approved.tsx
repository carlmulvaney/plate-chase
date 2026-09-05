import { createClient } from '@/lib/supabase/server'
import { formatTarget } from '@/lib/plate'

/**
 * Claims that counted because nobody objected in time, rather than because
 * anyone approved them.
 *
 * Deliberately not on the review screen: there is nothing to decide here, and
 * a queue is for things that need deciding. It belongs beside a player's own
 * progress, which is where it is until §9's leaderboard exists.
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

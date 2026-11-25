import { useState, type ReactNode } from 'react'
import { forgetDeviceId, storedDeviceId } from '../lib/ratings'

/**
 * Where people can ask for their ratings to be removed. Empty = the sentence is hidden.
 * Fill in an email or link before going public.
 */
const CONTACT = ''

export function PrivacyPage() {
  const [id, setId] = useState(storedDeviceId)

  return (
    <main className="px-4 pt-6 pb-4 sm:px-8">
      <a href="#" className="text-mist underline underline-offset-2 hover:text-foam">
        Back to the forecast
      </a>
      <h1 className="mt-4 font-display text-5xl font-black">What we save</h1>
      <p className="mt-3 max-w-[60ch] text-lg">
        No account, no name, no email. Only what you send when you rate a session, used to make the
        forecast better.
      </p>

      <Section title="When you rate a session">
        <ul className="list-disc space-y-1.5 pl-5">
          <li>Your answers: when (today or yesterday, part of the day), the 1-5 score, and wave size, surface, crowd and comment if you gave them.</li>
          <li>Your comment is shown publicly on the spot screen under today’s reports, with your score and the part of the day. Nothing else about you is shown with it, so don’t write your name in it.</li>
          <li>The forecast numbers and score the app showed for that hour, so we can see where the forecast was wrong.</li>
          <li>
            Later, the weather public stations measured near the beach around that time (rain, wind, temperature; Meteocat open data), so
            a rainy day with good waves isn’t learned as bad waves.
          </li>
          <li>The app version.</li>
          <li>A random device id, created on this phone. It isn’t linked to you; it lets us limit each phone to 3 ratings a day and spot spam.</li>
          <li>“At the beach: yes”, only if you tapped the location check and your phone found it was within 3 km of the beach.</li>
        </ul>
      </Section>

      <Section title="What we never save">
        <ul className="list-disc space-y-1.5 pl-5">
          <li>Your location. The distance check happens on your phone; the position is never sent anywhere.</li>
          <li>Your IP address, in our database.</li>
          <li>Anything about you if you only look at the forecast.</li>
          <li>Cookies, or any id for counting visitors.</li>
        </ul>
      </Section>

      <Section title="Counting visits">
        <p>
          Each time the app opens, it adds 1 to a counter for that day (one counter for the browser, one for
          the installed app), and 1 to another when your browser reports that the app was installed.
          Only the daily totals are kept: no cookie, no id, nothing stored on your phone, nothing
          that tells one visit from another.
        </p>
      </Section>

      <Section title="Who sees it">
        <p>
          Everyone sees summaries: how many people rated today, the average score, the most common
          wave size and crowd, the latest comments, and the daily average for the last 14 days. Single
          ratings can’t be read, changed or deleted through the app, not even by whoever sent them; only
          the nightly training job and the app’s admin (to hide spam) read them. Like any website, the services we use (Supabase for the
          database, and our hosting) may keep short technical logs of requests.
        </p>
      </Section>

      <Section title="Other services your browser talks to">
        <p>
          Open-Meteo, for the forecast. It gets the beach’s position, never yours, and sees your IP
          address, as any website you load does. OpenStreetMap, only when you open the map: its
          servers send the map pictures for the area on screen and see your IP address too.
          Everything else (including the fonts) comes from this app itself.
        </p>
      </Section>

      <Section title="Stored on this phone">
        <p>
          The app itself and the last forecast, AI scores and report summaries it loaded (so it opens
          instantly and works offline), the times of your last ratings (for the 3-a-day limit), the
          device id, and your favourite spots, list/map choice and “Your surf” settings (level, max wave size, rain; never sent anywhere). Clearing this site’s data, or removing the app, removes all of it.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-kelp px-3 py-2.5">
          <span className="text-sm text-mist">Device id:</span>
          <code className="text-sm break-all">{id ?? 'none yet (created when you first rate)'}</code>
          {id && (
            <button
              type="button"
              onClick={() => {
                forgetDeviceId()
                setId(null)
              }}
              className="ml-auto rounded-lg border border-kelp px-2.5 py-1 text-sm hover:border-mist"
            >
              Forget it
            </button>
          )}
        </div>
        <p className="mt-2 text-sm text-mist">
          Forgetting it means your next rating gets a new id. Ratings already sent stay, without anything
          linking them to you.
          {CONTACT && ` To have ratings from this phone removed, send the id above to ${CONTACT}.`}
        </p>
      </Section>

      <Section title="Surf alerts (only if you turn one on)">
        <p>
          To send an alert we store your browser’s push address (a long random link at Google,
          Apple, Mozilla or Microsoft, who deliver the notification), its encryption keys, the
          spot and the score you picked. No name, location or device id. The alert text goes
          through that push service, encrypted. “Turn off” deletes it at once; so does
          removing the app, the next time an alert would be sent.
        </p>
      </Section>
    </main>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-8 max-w-[64ch]">
      <h2 className="mb-2 font-display text-2xl font-extrabold">{title}</h2>
      {children}
    </section>
  )
}

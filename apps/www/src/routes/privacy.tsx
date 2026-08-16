import { createFileRoute } from "@tanstack/react-router";

import { LegalPage, LegalSection } from "@/components/legal-page";

export const Route = createFileRoute("/privacy")({
  component: PrivacyPage,
  head: () => ({
    meta: [
      { title: "Privacy Policy — qali" },
      {
        name: "description",
        content:
          "How qali collects, uses, stores, and shares your Google Calendar and contacts data.",
      },
    ],
  }),
});

function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy" updated="August 16, 2026">
      <p>
        qali (&ldquo;qali,&rdquo; &ldquo;we,&rdquo; &ldquo;us&rdquo;) is an
        AI-native calendar for Google Calendar. This policy
        explains what data we access when you connect your Google account, why
        we access it, how long we keep it, and who we share it with. We designed
        qali to hold as little as it needs to run the calendar you asked it to
        run.
      </p>

      <LegalSection heading="Who we are">
        <p>
          qali is the data controller for the information described here. If you
          have any question about this policy or want to exercise your rights,
          contact us at{" "}
          <a href="mailto:privacy@qali.app">privacy@qali.app</a>.
        </p>
      </LegalSection>

      <LegalSection heading="Data we collect">
        <p>
          Almost everything qali holds comes from Google, with your permission,
          at the moment you sign in and while the app is connected:
        </p>
        <ul>
          <li>
            <strong>Account identity.</strong> When you sign in with Google we
            receive your name, email address, and profile picture (the standard
            OpenID <em>email</em> and <em>profile</em> scopes). This identifies
            your account and shows your avatar in the app.
          </li>
          <li>
            <strong>Google Calendar.</strong> With the Google Calendar scope we
            read and write your calendars and their events — event titles,
            descriptions, times, locations, guests and their responses,
            free/busy status, recurrence rules, and Google Meet links — so you
            can view, create, edit, and reschedule events from qali.
          </li>
          <li>
            <strong>Google Contacts.</strong> With the read-only Contacts scope
            we read your saved contacts — names, email addresses, phone numbers,
            and photos.
          </li>
          <li>
            <strong>Google &ldquo;Other contacts.&rdquo;</strong> With the
            read-only Other Contacts scope we read the addresses Google
            auto-collects for people you have interacted with but never saved.
            This is how guests show a real name and avatar even when they are
            not in your contacts.
          </li>
          <li>
            <strong>A people directory we build.</strong> From your calendar
            guests and both contact sources, qali derives a unified,
            email-keyed directory of the people you meet with. It includes
            derived fields such as how many times and when you have met and a
            relevance score used only to order results.
          </li>
          <li>
            <strong>Booking pages.</strong> If you create a public booking page,
            we store its settings and availability. When someone requests a
            time, we store the name, email address, and any note they submit.
          </li>
          <li>
            <strong>Assistant conversations.</strong> If you use the optional AI
            scheduling assistant, we store your chat threads and the proposed
            actions so the conversation persists between sessions.
          </li>
          <li>
            <strong>Waitlist.</strong> If you join the waitlist on our website,
            we store the email address you submit.
          </li>
          <li>
            <strong>Operational logs.</strong> Our hosting providers keep
            standard technical logs (such as timestamps and error traces) needed
            to run, secure, and debug the service. qali does not use advertising
            trackers or third-party analytics pixels on its website or app.
          </li>
        </ul>
      </LegalSection>

      <LegalSection heading="How we use your data">
        <p>We use the data above only to provide and operate qali:</p>
        <ul>
          <li>
            Sync and display your calendars and let you create, edit, and
            reschedule events.
          </li>
          <li>
            Build the people directory so guests show real names and avatars,
            and so you can find people quickly.
          </li>
          <li>Run your public booking pages and notify you of requests.</li>
          <li>
            Power the optional AI scheduling assistant when you choose to use
            it.
          </li>
          <li>Keep the service secure, reliable, and debuggable.</li>
        </ul>
        <p>
          We do <strong>not</strong> sell your data, use it for advertising, or
          use your Google Calendar or contacts data to train generalized AI or
          machine-learning models.
        </p>
      </LegalSection>

      <LegalSection heading="The AI scheduling assistant">
        <p>
          The AI assistant is optional and off unless you use it. When you send
          it a message, qali sends the content needed to answer your request —
          which can include relevant calendar events, people from your
          directory, and pending booking requests — to our model provider,{" "}
          <a href="https://www.deepseek.com" target="_blank" rel="noreferrer">
            DeepSeek
          </a>
          , to generate a response. We send only what a given request needs, and
          only when you actively use the assistant. If you never open it, none
          of your data is sent to the model provider.
        </p>
      </LegalSection>

      <LegalSection heading="Google API Limited Use disclosure">
        <p>
          qali&rsquo;s use of information received from Google APIs adheres to
          the{" "}
          <a
            href="https://developers.google.com/terms/api-services-user-data-policy"
            target="_blank"
            rel="noreferrer"
          >
            Google API Services User Data Policy
          </a>
          , including its Limited Use requirements. We only use Google user data
          to provide and improve the qali features you see, we do not transfer
          it to others except as needed to provide those features (see below),
          we do not use it for advertising, and no humans read your Google data
          except where you explicitly ask us to, for security or to comply with
          the law.
        </p>
      </LegalSection>

      <LegalSection heading="Who we share it with">
        <p>
          We share data only with the service providers that make qali work,
          each acting on our behalf under contract:
        </p>
        <ul>
          <li>
            <strong>Google</strong> — the source of your calendar and contacts
            data, via the Google Calendar and People APIs.
          </li>
          <li>
            <strong>Convex</strong> — our backend and database host, where your
            qali data is stored.
          </li>
          <li>
            <strong>Cloudflare</strong> — hosts our website and application.
          </li>
          <li>
            <strong>DeepSeek</strong> — our AI model provider, which receives
            request context only when you use the assistant (see above).
          </li>
        </ul>
        <p>
          We may also disclose data if required by law, or to protect the
          rights, safety, and security of qali and its users. We do not sell
          your personal information.
        </p>
      </LegalSection>

      <LegalSection heading="How long we keep it">
        <ul>
          <li>
            <strong>Calendar events</strong> are retained for about 180 days
            around the current date; older events are removed from qali (they
            remain in Google Calendar).
          </li>
          <li>
            <strong>Assistant conversations</strong> are deleted after roughly
            30 days of inactivity.
          </li>
          <li>
            <strong>Contacts, the people directory, calendars, and booking
            settings</strong>{" "}
            are kept while your account is connected and refreshed as your
            Google data changes.
          </li>
          <li>
            When you disconnect or delete your account, we delete the data we
            hold for you, except where we must keep limited records to comply
            with the law.
          </li>
        </ul>
      </LegalSection>

      <LegalSection heading="Security and credentials">
        <p>
          qali signs you in through Google OAuth; we never see or store a Google
          password. Access to your Google account is handled by access and
          refresh tokens managed by our authentication layer, not stored in
          plain text in application data. We use industry-standard measures to
          protect data in transit and at rest, though no method is perfectly
          secure.
        </p>
      </LegalSection>

      <LegalSection heading="Your choices and rights">
        <ul>
          <li>
            <strong>Revoke access at any time</strong> from your{" "}
            <a
              href="https://myaccount.google.com/permissions"
              target="_blank"
              rel="noreferrer"
            >
              Google Account permissions
            </a>
            . qali immediately loses access to your Google data.
          </li>
          <li>
            <strong>Access, correct, or delete</strong> the data we hold, and
            request a copy, by contacting us. Depending on where you live, you
            may have these rights under laws such as the GDPR or CCPA.
          </li>
          <li>
            <strong>Delete your account</strong> to have your qali data removed.
          </li>
        </ul>
        <p>
          To make any of these requests, email{" "}
          <a href="mailto:privacy@qali.app">privacy@qali.app</a>.
        </p>
      </LegalSection>

      <LegalSection heading="Children">
        <p>
          qali is not directed to children under 16, and we do not knowingly
          collect their data.
        </p>
      </LegalSection>

      <LegalSection heading="Changes to this policy">
        <p>
          We may update this policy as qali evolves. When we make material
          changes, we will update the date above and, where appropriate, notify
          you. Continued use of qali after a change means you accept the updated
          policy.
        </p>
      </LegalSection>
    </LegalPage>
  );
}

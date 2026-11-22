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
          "How qali accesses, uses, stores, shares, protects, and deletes your Google Calendar and contacts data.",
      },
    ],
  }),
});

const USER_DATA_POLICY_URL =
  "https://developers.google.com/terms/api-services-user-data-policy";

function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy" updated="November 23, 2026">
      <p>
        qali (&ldquo;qali,&rdquo; &ldquo;we,&rdquo; &ldquo;us&rdquo;) is an
        AI-native calendar for Google Calendar, available on the web and as a
        Mac app. This policy explains what Google user data and other
        information qali accesses, how we use it, who we share it with, how we
        protect it, how long we keep it, and how you can have it deleted. We
        designed qali to hold as little as it needs to run the calendar you
        asked it to run.
      </p>

      <LegalSection heading="Who we are">
        <p>
          qali is the data controller for the information described here. If you
          have any question about this policy or want to exercise your rights,
          contact us at{" "}
          <a href="mailto:privacy@myqali.com">privacy@myqali.com</a>.
        </p>
      </LegalSection>

      <LegalSection heading="Google user data we access">
        <p>
          When you sign in with Google, qali asks for the permissions below.
          Google shows them on its consent screen, and we access nothing until
          you approve it there:
        </p>
        <ul>
          <li>
            <strong>Basic profile</strong> (the OpenID <em>email</em> and{" "}
            <em>profile</em> scopes). Your name, email address, and profile
            picture, used to identify your account and show your avatar.
          </li>
          <li>
            <strong>Google Calendar</strong> (
            <code>calendar</code>, read and write). Your calendars and their
            events — titles, descriptions, times, locations, guests and their
            responses, free/busy status, recurrence rules, reminders, and Google
            Meet links — so you can view, create, edit, reschedule, and respond
            to events from qali.
          </li>
          <li>
            <strong>Google Contacts</strong> (<code>contacts.readonly</code>).
            Your saved contacts — names, email addresses, phone numbers, and
            photos — read only.
          </li>
          <li>
            <strong>Google &ldquo;Other contacts&rdquo;</strong> (
            <code>contacts.other.readonly</code>). The names and addresses Google
            collects automatically for people you have interacted with but never
            saved, read only. This is how guests show a real name and avatar
            even when they are not in your contacts.
          </li>
        </ul>
        <p>
          If you connect more than one Google account, the same permissions
          apply to each account you connect.
        </p>
      </LegalSection>

      <LegalSection heading="Other information we collect">
        <ul>
          <li>
            <strong>A people directory we build.</strong> From your calendar
            guests and both contact sources, qali derives an email-keyed
            directory of the people you meet with, including how often and when
            you have met and a relevance score used only to order results.
          </li>
          <li>
            <strong>Booking pages.</strong> If you publish a public booking page,
            we store its settings and your availability. When someone requests a
            time, we store the name, email address, and optional note they
            submit.
          </li>
          <li>
            <strong>Assistant conversations.</strong> If you use the optional AI
            scheduling assistant, we store your chat thread and the changes it
            proposed so the conversation persists between sessions.
          </li>
          <li>
            <strong>Reminders and notifications.</strong> The reminders we
            schedule for your events, the in-app notifications we show you, and,
            if you turn on browser notifications, your browser&rsquo;s push
            subscription.
          </li>
          <li>
            <strong>Preferences.</strong> Settings you choose in qali, such as
            your working time zone and display options.
          </li>
          <li>
            <strong>Waitlist.</strong> If you join the waitlist on our website,
            the email address you submit.
          </li>
          <li>
            <strong>Operational logs.</strong> Our hosting providers keep
            standard technical logs (such as timestamps and error traces) needed
            to run, secure, and debug the service. qali uses no advertising
            trackers or third-party analytics on its website or apps.
          </li>
        </ul>
        <p>
          The Mac app keeps your sign-in session in the macOS Keychain and your
          app preferences on your Mac. It checks for updates by downloading
          release information from GitHub, which sends no account or calendar
          data.
        </p>
      </LegalSection>

      <LegalSection heading="How we use your data">
        <p>
          We use the data above only to provide and improve the qali features
          you see and use:
        </p>
        <ul>
          <li>
            Sync and display your calendars, and create, edit, reschedule, and
            respond to events when you ask us to.
          </li>
          <li>
            Show guests with real names and avatars, and let you find the people
            you meet with.
          </li>
          <li>
            Run your public booking pages and tell you about new requests.
          </li>
          <li>Send the event reminders you set.</li>
          <li>
            Answer your requests to the optional AI scheduling assistant.
          </li>
          <li>
            Keep the service secure and reliable, and investigate abuse.
          </li>
        </ul>
        <p>
          We do <strong>not</strong> sell your data, use it for advertising or
          retargeting, share it with data brokers or information resellers, or
          use it to determine creditworthiness or for lending.
        </p>
      </LegalSection>

      <LegalSection heading="AI and machine learning">
        <p>
          qali does <strong>not</strong> use data obtained through Google
          Workspace APIs — your Google Calendar and Google Contacts data — or any
          data derived from it to develop, improve, or train generalized or
          non-personalized artificial intelligence or machine-learning models.
          Nor do we allow anyone else, including our AI model provider, to do
          so.
        </p>
        <p>
          The AI scheduling assistant is optional. Only when you send it a
          message does qali send the content needed to answer that request —
          which can include relevant calendar events, people from your
          directory, and pending booking requests — to our model provider,{" "}
          <a href="https://fireworks.ai" target="_blank" rel="noreferrer">
            Fireworks AI
          </a>
          , to generate the reply. Fireworks processes these requests under a
          zero data retention policy: it does not store or log the content we
          send or the replies it generates, and does not use them for training.
          If you never use the assistant, none of your data is sent to a model
          provider. The assistant never changes your calendar on its own: every
          change it proposes waits for you to confirm it.
        </p>
      </LegalSection>

      <LegalSection heading="Google API Services User Data Policy">
        <p>
          qali&rsquo;s use and transfer to any other app of information
          received from Google APIs will adhere to the{" "}
          <a href={USER_DATA_POLICY_URL} target="_blank" rel="noreferrer">
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements. In particular:
        </p>
        <ul>
          <li>
            We use Google user data only to provide or improve the user-facing
            features of qali described above.
          </li>
          <li>
            We transfer it to others only as needed to provide or improve those
            features (to the service providers listed below), to comply with
            applicable law, for security purposes such as investigating abuse,
            or as part of a merger, acquisition, or sale of assets after
            obtaining your explicit prior consent.
          </li>
          <li>
            We do not use or transfer it for serving ads, including personalized
            or interest-based ads.
          </li>
          <li>
            No person reads your Google user data unless you have given us your
            affirmative agreement for specific messages or events (for example,
            when you ask us for support), it is necessary for security purposes
            such as investigating abuse, it is necessary to comply with
            applicable law, or the data has been aggregated and anonymized and is
            used for internal operations.
          </li>
        </ul>
      </LegalSection>

      <LegalSection heading="Who we share it with">
        <p>
          We share data only with the service providers that make qali work,
          each processing it on our behalf and only to provide qali:
        </p>
        <ul>
          <li>
            <strong>Google</strong> — the source of your calendar and contacts
            data, through the Google Calendar and People APIs. Changes you make
            in qali are written back to your Google Calendar.
          </li>
          <li>
            <strong>Convex</strong> — our backend and database host, where the
            data qali stores is kept.
          </li>
          <li>
            <strong>Cloudflare</strong> — hosts our website and web app.
          </li>
          <li>
            <strong>Fireworks AI</strong> — our AI model provider, which receives
            request context only when you use the assistant, and retains none of
            it (see above).
          </li>
          <li>
            <strong>Your browser&rsquo;s push service</strong> (for example
            Apple, Google, or Mozilla) — delivers reminder notifications if you
            turn on browser notifications. Notification contents are encrypted
            end to end so the push service cannot read them.
          </li>
        </ul>
        <p>
          When someone books time with you through your booking page, the event
          is created in your Google Calendar and the requester receives
          Google&rsquo;s invitation. We may also disclose data if required by
          law, or to protect the rights, safety, and security of qali and its
          users. We do not sell your personal information.
        </p>
      </LegalSection>

      <LegalSection heading="How we protect it">
        <ul>
          <li>
            All traffic between your device, qali, Google, and our providers is
            encrypted in transit with HTTPS (TLS).
          </li>
          <li>
            Google access and refresh tokens are encrypted before they are
            stored, and are used only by our backend to call Google on your
            behalf. We never see or store your Google password.
          </li>
          <li>
            Data at rest is stored with our infrastructure providers, who encrypt
            it.
          </li>
          <li>
            Access to production systems is restricted to the people who operate
            qali, and the assistant treats calendar and booking content as
            untrusted data so that text inside an event cannot direct it.
          </li>
        </ul>
        <p>
          No method of transmission or storage is perfectly secure. If we learn
          of unauthorized access to your data, we will notify you and the
          relevant authorities as the law requires.
        </p>
      </LegalSection>

      <LegalSection heading="How long we keep it">
        <p>
          We keep data only as long as qali needs it, and delete it on the
          schedules below. Deleting data from qali never deletes it from your
          Google account.
        </p>
        <ul>
          <li>
            <strong>Calendar events</strong> are kept from 180 days in the past
            to 365 days in the future. Events outside that window are deleted
            from qali automatically every day.
          </li>
          <li>
            <strong>Calendars, contacts, the people directory, and
            preferences</strong>{" "}
            are kept while the Google account they came from stays connected,
            and are refreshed as your Google data changes.
          </li>
          <li>
            <strong>Assistant conversations</strong> are deleted 30 days after
            their last message. Starting a new chat deletes the previous one
            straight away.
          </li>
          <li>
            <strong>Booking requests</strong> that are not answered expire after
            48 hours or once the requested time has passed. The record of a
            request (the requester&rsquo;s name, email, note, and its outcome) is
            kept with your booking page until your account is deleted.
          </li>
          <li>
            <strong>Reminder delivery records</strong> are deleted 7 days after
            the reminder fires. <strong>Notifications</strong> are deleted when
            you dismiss or clear them.
          </li>
          <li>
            <strong>Records of calendar changes</strong> qali made for you (used
            to retry safely and avoid duplicates) are deleted after 90 days, and
            booking rate-limit counters after 24 hours.
          </li>
          <li>
            <strong>Operational logs</strong> are kept by our hosting providers
            for a limited period under their standard retention.
          </li>
        </ul>
      </LegalSection>

      <LegalSection heading="Deleting your data">
        <ul>
          <li>
            <strong>Disconnect an extra Google account</strong> from Settings
            in qali. We revoke qali&rsquo;s access at Google straight away and
            delete everything synced from that account.
          </li>
          <li>
            <strong>Revoke qali&rsquo;s access</strong> at any time from your{" "}
            <a
              href="https://myaccount.google.com/connections"
              target="_blank"
              rel="noreferrer"
            >
              Google Account
            </a>
            . qali immediately loses access to your Google data and stops
            syncing.
          </li>
          <li>
            <strong>Delete your account and all its data</strong> by emailing{" "}
            <a href="mailto:privacy@myqali.com">privacy@myqali.com</a> from the
            address you sign in with. Within 30 days we revoke qali&rsquo;s
            access at Google and delete your account, your stored Google tokens,
            and everything qali holds for you — events, calendars, contacts,
            the people directory, booking pages and requests, assistant
            conversations, reminders, notifications, preferences, and any
            waitlist entry — and confirm by email. We keep only what the law
            requires us to.
          </li>
        </ul>
      </LegalSection>

      <LegalSection heading="Your rights">
        <p>
          You can ask us to access, correct, or delete the data we hold about
          you, or for a copy of it, by emailing{" "}
          <a href="mailto:privacy@myqali.com">privacy@myqali.com</a>. Depending
          on where you live, you may have further rights under laws such as the
          GDPR or CCPA, including the right to object to or restrict
          processing and to complain to a data protection authority. We will
          not discriminate against you for exercising them.
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
          We may update this policy as qali evolves. Before we use your data in
          a new way that this policy does not describe, we will update it and
          notify you in the app or by email, and ask for your consent where the
          law or Google&rsquo;s policies require it. The date above always shows
          the latest revision.
        </p>
      </LegalSection>
    </LegalPage>
  );
}

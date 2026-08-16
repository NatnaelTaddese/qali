import { createFileRoute } from "@tanstack/react-router";

import { LegalPage, LegalSection } from "@/components/legal-page";

export const Route = createFileRoute("/terms")({
  component: TermsPage,
  head: () => ({
    meta: [
      { title: "Terms of Service — qali" },
      {
        name: "description",
        content: "The terms that govern your use of qali.",
      },
    ],
  }),
});

function TermsPage() {
  return (
    <LegalPage title="Terms of Service" updated="August 16, 2026">
      <p>
        These Terms of Service (&ldquo;Terms&rdquo;) govern your use of qali, a
        calendar client for Google Calendar. By signing in or otherwise using
        qali, you agree to these Terms. If you do not agree, do not use qali.
      </p>

      <LegalSection heading="The service">
        <p>
          qali connects to your Google account to sync your calendars and
          contacts, builds a unified people directory, and lets you view,
          create, edit, and reschedule events. It also offers optional features
          including public booking pages and an AI scheduling assistant. qali is
          currently in beta, which means features may change, break, or be
          removed, and availability is not guaranteed.
        </p>
      </LegalSection>

      <LegalSection heading="Eligibility and your account">
        <p>
          You must be at least 16 years old and able to form a binding contract
          to use qali. You access qali by signing in with a Google account you
          are authorized to use, and you are responsible for activity that
          happens through your account. You must keep your Google account secure;
          qali relies on Google to authenticate you and never handles your
          Google password.
        </p>
      </LegalSection>

      <LegalSection heading="Google account connection">
        <p>
          To work, qali needs the Google permissions you grant at sign-in,
          including read and write access to your Google Calendar and read-only
          access to your contacts. You can revoke these permissions at any time
          from your{" "}
          <a
            href="https://myaccount.google.com/permissions"
            target="_blank"
            rel="noreferrer"
          >
            Google Account permissions
          </a>
          , which will stop qali from functioning. Your use of Google&rsquo;s
          services remains subject to Google&rsquo;s own terms.
        </p>
      </LegalSection>

      <LegalSection heading="Acceptable use">
        <p>You agree not to:</p>
        <ul>
          <li>Use qali to break the law or infringe anyone&rsquo;s rights.</li>
          <li>
            Access data, calendars, or accounts you are not authorized to
            access.
          </li>
          <li>
            Interfere with, overload, probe, or attempt to bypass the security
            of the service or its providers.
          </li>
          <li>
            Reverse engineer, scrape, or resell the service except as permitted
            by law.
          </li>
          <li>
            Use booking pages or the assistant to send spam or harass others.
          </li>
        </ul>
      </LegalSection>

      <LegalSection heading="Booking pages">
        <p>
          If you publish a booking page, you are responsible for its content and
          for the accuracy of the availability you offer. People who request
          time submit their name, email, and an optional note; you are
          responsible for handling that information appropriately. We may apply
          rate limits and other protections to keep booking pages from being
          abused.
        </p>
      </LegalSection>

      <LegalSection heading="The AI assistant">
        <p>
          The AI scheduling assistant is optional and generates suggestions and
          proposed actions that can be wrong. Scheduling actions it proposes take
          effect only after you confirm them, and you are responsible for
          reviewing them before they apply to your calendar. When you use the
          assistant, request context is processed by our model provider as
          described in the{" "}
          <a href="/privacy">Privacy Policy</a>.
        </p>
      </LegalSection>

      <LegalSection heading="Your content">
        <p>
          Your calendars, events, contacts, and messages remain yours. You grant
          qali only the permission needed to operate the service for you — to
          store, process, sync, and display your data, and to carry out the
          actions you request. We claim no ownership of your content.
        </p>
      </LegalSection>

      <LegalSection heading="Availability and changes">
        <p>
          We may modify, suspend, or discontinue qali or any feature at any
          time, and we may set or change limits on use. We aim to give notice of
          significant changes where practical, but qali is provided on an ongoing,
          best-effort basis, especially during beta.
        </p>
      </LegalSection>

      <LegalSection heading="Disclaimers">
        <p>
          qali is provided &ldquo;as is&rdquo; and &ldquo;as available,&rdquo;
          without warranties of any kind, whether express or implied, including
          fitness for a particular purpose, merchantability, and
          non-infringement. We do not warrant that qali will be uninterrupted,
          error-free, or that it will always sync accurately with Google. You are
          responsible for verifying important scheduling information.
        </p>
      </LegalSection>

      <LegalSection heading="Limitation of liability">
        <p>
          To the maximum extent permitted by law, qali and its providers will
          not be liable for any indirect, incidental, special, consequential, or
          punitive damages, or for any loss of data, meetings, profits, or
          goodwill, arising out of or related to your use of qali. Nothing in
          these Terms limits liability that cannot be limited under applicable
          law.
        </p>
      </LegalSection>

      <LegalSection heading="Termination">
        <p>
          You may stop using qali at any time by disconnecting your Google
          account or deleting your account. We may suspend or terminate your
          access if you violate these Terms or if we discontinue the service. On
          termination, we handle your data as described in the{" "}
          <a href="/privacy">Privacy Policy</a>.
        </p>
      </LegalSection>

      <LegalSection heading="Changes to these Terms">
        <p>
          We may update these Terms from time to time. When we make material
          changes, we will update the date above. Continued use of qali after a
          change means you accept the updated Terms.
        </p>
      </LegalSection>

      <LegalSection heading="Contact">
        <p>
          Questions about these Terms? Email{" "}
          <a href="mailto:support@qali.app">support@qali.app</a>.
        </p>
      </LegalSection>
    </LegalPage>
  );
}

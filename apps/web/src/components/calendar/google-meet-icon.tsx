import { svg } from "thesvg/google-meet-2026";

const googleMeetIconSrc = `data:image/svg+xml,${encodeURIComponent(svg)}`;

export function GoogleMeetIcon({ className }: { className?: string }) {
  return (
    <img
      src={googleMeetIconSrc}
      alt=""
      aria-hidden
      draggable={false}
      className={className}
    />
  );
}

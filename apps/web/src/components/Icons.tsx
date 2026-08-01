import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

function IconFrame({ children, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      {...props}
    >
      {children}
    </svg>
  );
}

export function ArrowIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M5 12h14M14 7l5 5-5 5" />
    </IconFrame>
  );
}

export function CameraIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <rect x="3" y="6" width="13" height="12" rx="3" />
      <path d="m16 10 5-3v10l-5-3" />
    </IconFrame>
  );
}

export function CameraOffIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="m3 3 18 18M10.7 6H6a3 3 0 0 0-3 3v6a3 3 0 0 0 3 3h8a3 3 0 0 0 2.6-1.5M16 10l5-3v10l-2.3-1.4M14.4 6.1A3 3 0 0 1 16 9v4.4" />
    </IconFrame>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="m5 12 4 4L19 6" />
    </IconFrame>
  );
}

export function ChevronIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="m8 10 4 4 4-4" />
    </IconFrame>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="m6 6 12 12M18 6 6 18" />
    </IconFrame>
  );
}

export function CopyIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <rect x="8" y="8" width="11" height="11" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </IconFrame>
  );
}

export function MessageIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M21 11.5a8.2 8.2 0 0 1-9 8 9.4 9.4 0 0 1-3.5-.8L3 20l1.4-4.6A8 8 0 1 1 21 11.5Z" />
    </IconFrame>
  );
}

export function MicIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <rect x="8" y="3" width="8" height="12" rx="4" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </IconFrame>
  );
}

export function MicOffIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="m3 3 18 18M9 5.2V11a3 3 0 0 0 4.8 2.4M15.8 10.8V7a3.8 3.8 0 0 0-6.5-2.7M5 11a7 7 0 0 0 11.7 5.2M12 18v3" />
    </IconFrame>
  );
}

export function PhoneOffIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M4.5 10.5c4.8-4 10.2-4 15 0M6.5 9l2.2 4-2.6 2.3a2 2 0 0 1-2.8-.2L2 13.7a2 2 0 0 1 .2-2.8L4.5 9M17.5 9l-2.2 4 2.6 2.3a2 2 0 0 0 2.8-.2l1.3-1.4a2 2 0 0 0-.2-2.8L19.5 9" />
    </IconFrame>
  );
}

export function SendIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="m22 2-7 20-4-9-9-4 20-7Z" />
      <path d="M22 2 11 13" />
    </IconFrame>
  );
}

export function ScreenShareIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8M12 17v4M8.5 11.5 12 8l3.5 3.5M12 8v6" />
    </IconFrame>
  );
}

export function UsersIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" />
    </IconFrame>
  );
}

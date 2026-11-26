export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 36 36"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="shrink-0"
      aria-hidden="true"
    >
      {/* Print-Web 3D nozzle & build plate mark */}
      <path
        d="M12 6.5H24V14.5L19.5 21H16.5L12 14.5V6.5Z"
        stroke="#00A7D9"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      <path
        d="M18 21V24.5"
        stroke="#00A7D9"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <path
        d="M11 25.5H25"
        stroke="currentColor"
        className="text-[#111318] dark:text-[#F4F5F7]"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <path
        d="M6.5 29.5H29.5"
        stroke="currentColor"
        className="text-black/20 dark:text-white/25"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

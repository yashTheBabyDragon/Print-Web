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
      {/* Architectural arch mark referencing Cégep Gérald-Godin */}
      <path
        d="M8.5 29V17.5C8.5 11.701 12.7533 7 18 7C23.2467 7 27.5 11.701 27.5 17.5V29"
        stroke="#00A7D9"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <path
        d="M14 29V18C14 15.2386 15.7909 13 18 13C20.2091 13 22 15.2386 22 18V21.5H18.2"
        stroke="currentColor"
        className="text-[#111318] dark:text-[#F4F5F7]"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
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

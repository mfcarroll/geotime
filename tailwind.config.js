/** @type {import('tailwindcss').Config} */
export default {
  // Compiles `hover:` to @media (hover: hover) rather than a bare :hover.
  //
  // Without this, iOS keeps :hover applied to whatever was last tapped until
  // something else is tapped. The World Clock list re-renders when a row is
  // removed, the next row slides into the tapped position, and it inherits the
  // red — so deleting one entry appears to mark a different one for deletion.
  // The pin button's yellow had the same fault.
  future: { hoverOnlyWhenSupported: true },
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}


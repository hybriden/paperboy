import { redirect } from "next/navigation";
import { DEFAULT_LOCALE } from "./lib/locale";

// "/" → the default locale, which renders the configured start page.
export default function Root() {
  redirect(`/${DEFAULT_LOCALE}`);
}

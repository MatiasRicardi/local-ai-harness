/**
 * Browser-derived presentation metadata for a chat request.
 *
 * The frontend owns user-local presentation information (IANA timezone,
 * locale) that the server cannot reliably infer. The backend generates the
 * authoritative current instant from its own clock (see Step 44), so this
 * payload intentionally carries **no** current date/time, offset, or
 * weekday.
 */
export interface RuntimeContext {
  timeZone: string
  locale: string
}

/**
 * Collect {@link RuntimeContext} from standard browser APIs.
 *
 * Returns `undefined` when either required value is missing, or when reading
 * `Intl` throws, so the caller can omit the field entirely and chat keeps
 * working. Never throws: a collection failure must not break chat.
 */
export function buildRuntimeContext(): RuntimeContext | undefined {
  try {
    const { timeZone, locale } = Intl.DateTimeFormat().resolvedOptions()

    const normalizedTimeZone = timeZone?.trim()
    const normalizedLocale = locale?.trim()

    // Both values are required; omit the whole field rather than guessing a
    // fallback so the backend never receives half of the payload.
    if (!normalizedTimeZone || !normalizedLocale) {
      return undefined
    }

    return {
      timeZone: normalizedTimeZone,
      locale: normalizedLocale,
    }
  } catch {
    // Reading Intl metadata is best-effort; absence must not fail the request.
    return undefined
  }
}

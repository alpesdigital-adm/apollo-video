import OidcCallback from './OidcCallback'

export const dynamic = 'force-dynamic'

export default async function OidcCallbackPage({
  searchParams,
}: Readonly<{ searchParams: Promise<{ code?: string | string[]; state?: string | string[] }> }>) {
  const parameters = await searchParams
  const code = Array.isArray(parameters.code) ? parameters.code[0] : parameters.code
  const state = Array.isArray(parameters.state) ? parameters.state[0] : parameters.state
  if (!code || !state) {
    return <main className="grid min-h-screen place-items-center bg-[#08090d] px-6 text-[#f4f5f7]"><p>Callback de autenticaÃ§Ã£o invÃ¡lido. <a className="underline" href="/login">Voltar ao login</a></p></main>
  }
  return <OidcCallback code={code} state={state} />
}

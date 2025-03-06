export function FallbackComponent({error}: { error: Error }) {
  return <div>Something went wrong: {error.message}</div>
}

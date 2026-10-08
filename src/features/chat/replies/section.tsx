export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h4 className="text-ui font-medium text-primary">{title}</h4>
      {children}
    </section>
  )
}

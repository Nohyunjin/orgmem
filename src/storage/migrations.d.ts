// Ambient type for `.sql` text-imports used by migrations.generated.ts.
// Bun's `with { type: "text" }` returns the file contents as a string;
// TypeScript needs this declaration to type-check the import.
declare module "*.sql" {
  const content: string;
  export default content;
}

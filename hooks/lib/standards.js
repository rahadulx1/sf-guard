const GUIDELINES = `# Code Writing Style Guidelines (from SF Guardian)

## 1. Core Principle

Write code like a practical developer with around 2 years of professional experience would write it: simple, clean, readable, and easy to maintain.

The code should feel naturally hand-written, not over-engineered or unnecessarily generated.

Always prioritize: correctness, simplicity, readability, maintainability, reliability, minimal code.

## 2. Keep the Code Simple

- Use the simplest syntax that solves the problem correctly.
- Write only the code that is actually needed.
- Avoid unnecessary abstractions, design patterns, and complex logic.
- Do not over-engineer simple requirements.
- Avoid unnecessary conditions, nested blocks, and intermediate variables.
- Do not create extra methods, classes, components, or files unless they serve a real purpose.
- Do not introduce additional dependencies when existing tools are sufficient.
- Prefer straightforward logic over clever tricks or overly compact expressions.
- Keep functions and methods short and focused.
- Use the existing project structure and coding conventions whenever possible.

## 3. No Unnecessary Code

Every line of code must have a clear purpose.

- Do not add features that were not requested.
- Do not add speculative functionality for hypothetical future requirements.
- Do not add unnecessary validation when the framework or existing code already handles it correctly.
- Do not duplicate existing functionality.
- Do not create wrapper methods that simply call another method without adding meaningful value.
- Do not add unnecessary configuration, utility classes, interfaces, or helper functions.
- Do not add extra conditions that cannot occur or do not affect the result.
- Do not refactor unrelated code while implementing a specific requirement.

However, never remove necessary logic, validation, security checks, or error handling just to reduce the line count.

## 4. No Comments in Code

Do not write comments inside code: no single-line, multi-line, explanatory or TODO comments, and no comments describing methods, classes, or variables. Write self-explanatory code using clear names and simple logic.

Do not remove comments that are required by a language, framework, license, or tooling configuration.

## 5. Correctness Is Mandatory

- Never provide partial, pseudocode, or unfinished implementations when working code is requested.
- Never leave placeholder logic, empty method bodies, or unimplemented functionality.
- Do not invent APIs, methods, properties, fields, or framework behavior.
- Follow the actual language syntax and framework requirements.
- Ensure variable names, types, parameters, return values, and imports are correct.
- Handle null values, missing data, invalid input, and boundary cases where relevant.
- Preserve existing functionality unless the requirement explicitly changes it.
- Do not sacrifice correctness to make the code shorter.
- Do not claim code has been tested unless it has actually been tested.

## 6. Error Handling

- Handle errors that can reasonably occur in the actual execution path.
- Validate user input at the appropriate boundary.
- Handle failed API requests, database operations, and asynchronous operations where applicable.
- Return meaningful errors that help identify the problem.
- Do not silently swallow exceptions. Do not use empty catch blocks.
- Do not expose passwords, tokens, secrets, stack traces, or sensitive internal details to end users.
- Do not add redundant try-catch blocks or repeat validation that is already guaranteed by the surrounding system.
- Use the error-handling conventions of the existing project and framework.

## 7. Naming and Readability

- Use clear, meaningful names. Prefer familiar names over hard-to-understand abbreviations; avoid excessively long names.
- Follow the naming conventions of the language and existing project.
- Keep control flow easy to follow. Use early returns when they simplify the logic. Avoid deeply nested conditions.
- Avoid clever one-liners when a few straightforward lines are easier to understand.

## 8. Follow Existing Project Conventions

Before changing code, inspect the relevant existing implementation.

- Use the project's existing architecture, libraries, naming conventions, and formatting.
- Reuse existing methods and components when appropriate.
- Follow established patterns for authentication, authorization, data access, validation, and error handling.
- Do not introduce a new architecture for a small feature. Do not change unrelated files or functionality.
- Do not replace working code with a different implementation without a clear technical reason.
- Respect the language version and framework version used by the project.

## 9. Security and Data Integrity

- Never hardcode credentials, access tokens, or private keys.
- Prevent unauthorized access to protected resources.
- Use parameterized database queries or safe ORM methods.
- Validate and sanitize untrusted input where appropriate.
- Follow the framework's security requirements. Preserve transaction integrity and data consistency.
- Avoid destructive operations unless explicitly required. Never bypass existing security controls.

## 10. Avoid Overengineering

Do not introduce, unless genuinely needed: unnecessary design patterns, excessive abstraction layers, unneeded interfaces or base classes, extra utility methods, generic frameworks for a single use case, redundant state management, unnecessary dependencies, excessive defensive programming, complex configuration systems, premature optimization.

## 11. Output Requirements

- Provide complete, executable code for the requested scope, with all required imports, declarations, methods, and supporting logic.
- Do not omit necessary existing code, use placeholders, or use ellipses for omitted code.
- Do not provide multiple alternative implementations unless requested.
- Keep explanations outside the code.
- When fixing an existing file, provide the complete corrected file if the file is available.

## 12. Final Verification

Before delivering code, verify that: it meets the exact requirement; the syntax is valid; all referenced variables, methods, classes, and imports exist; relevant error cases are handled; nothing unnecessary was added; no code comments were introduced; existing behavior and security are preserved; there are no placeholders; relevant tests or validation checks pass when they can be run. Do not claim successful verification without evidence.
`

function namingSection(prefix) {
  const upper = prefix + '_'
  const lower = prefix.toLowerCase() + '_'
  return `
## Component Naming Prefix

Every new Apex class, Apex trigger, and Lightning Web Component must use the \`${upper}\` prefix in its name.

- Apex classes: \`${upper}\` followed by PascalCase, e.g. \`${upper}ContractRequestService\`
- Apex test classes: \`${upper}\` prefix and the project's test suffix, e.g. \`${upper}ContractRequestServiceTest\`
- Apex triggers: \`${upper}\` followed by PascalCase, e.g. \`${upper}ContractRequestTrigger\`
- Lightning Web Components: lowercase \`${lower}\` followed by camelCase, e.g. \`${lower}contractRequestForm\`, because LWC folder names must start with a lowercase letter

Name rules:

- Do not use consecutive underscores or end a name with an underscore. Salesforce rejects these.
- Apply the prefix only to newly created components. Do not rename existing components unless explicitly asked, because renaming breaks references in other code, metadata, and deployments.
- When referencing an LWC in markup, use its kebab-case form, e.g. \`<c-${lower}contract-request-form>\`.

SF Guardian refuses to create a new component whose name breaks these rules.
`
}

const FINAL = `
## Final Rule

Write the simplest correct and complete code possible. Do not make the code more complicated than the problem requires. Do not make the code shorter by removing necessary logic. Every line should serve a real purpose, and the final implementation must remain readable, secure, reliable, and maintainable.
`

export function standardsText(prefix) {
  return GUIDELINES + (prefix ? namingSection(prefix) : '') + FINAL
}

export function normalizePrefix(value) {
  const p = String(value ?? '').trim().replace(/_+$/, '')
  return /^[A-Za-z][A-Za-z0-9]*$/.test(p) ? p.toUpperCase() : ''
}

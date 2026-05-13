import { handleElectricShapeProxy } from './shapeProxy.ts'

Deno.serve((request: Request) =>
  handleElectricShapeProxy(request, {
    ELECTRIC_URL: Deno.env.get('ELECTRIC_URL') ?? undefined,
    ELECTRIC_SOURCE_ID: Deno.env.get('ELECTRIC_SOURCE_ID') ?? undefined,
    ELECTRIC_SOURCE_SECRET: Deno.env.get('ELECTRIC_SOURCE_SECRET') ?? undefined,
    ELECTRIC_SHAPE_ALLOWED_ORIGINS: Deno.env.get('ELECTRIC_SHAPE_ALLOWED_ORIGINS') ?? undefined,
    SUPABASE_URL: Deno.env.get('SUPABASE_URL') ?? undefined,
    SUPABASE_ANON_KEY: Deno.env.get('SUPABASE_ANON_KEY') ?? undefined,
  }))

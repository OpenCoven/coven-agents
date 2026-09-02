ALTER TABLE "RunnerRun" DROP CONSTRAINT "RunnerRun_executionProvenance_valid";--> statement-breakpoint
ALTER TABLE "RunnerRun" ADD CONSTRAINT "RunnerRun_executionProvenance_valid" CHECK ("RunnerRun"."executionProvenance" is null or (
        jsonb_typeof("RunnerRun"."executionProvenance") = 'object'
        and "RunnerRun"."executionProvenance" ?& array['productExecutionClass', 'provider', 'capabilityContractVersion', 'adapterVersion', 'pinnedSnapshot', 'target', 'lifecycle']
        and ("RunnerRun"."executionProvenance" - 'productExecutionClass' - 'provider' - 'capabilityContractVersion' - 'adapterVersion' - 'pinnedSnapshot' - 'target' - 'lifecycle') = '{}'::jsonb
        and "RunnerRun"."executionProvenance"->>'productExecutionClass' = 'hosted'
        and "RunnerRun"."executionProvenance"->>'provider' in ('daytona', 'hermetic')
        and jsonb_typeof("RunnerRun"."executionProvenance"->'capabilityContractVersion') = 'string'
        and "RunnerRun"."executionProvenance"->>'capabilityContractVersion' ~ '^hosted-v[1-9][0-9]{0,2}$'
        and jsonb_typeof("RunnerRun"."executionProvenance"->'adapterVersion') = 'string'
        and (
          ("RunnerRun"."executionProvenance"->>'provider' = 'daytona'
            and "RunnerRun"."executionProvenance"->>'adapterVersion' ~ '^daytona-adapter-v[1-9][0-9]{0,2}$'
            and "RunnerRun"."executionProvenance"->>'pinnedSnapshot' ~ '^coven-agents-copilot-[0-9]{1,10}$'
            and "RunnerRun"."executionProvenance"->>'target' in ('eu', 'us')
            and "RunnerRun"."executionProvenance"->>'lifecycle' = 'persistent')
          or ("RunnerRun"."executionProvenance"->>'provider' = 'hermetic'
            and "RunnerRun"."executionProvenance"->>'adapterVersion' ~ '^hermetic-adapter-v[1-9][0-9]{0,2}$'
            and "RunnerRun"."executionProvenance"->>'pinnedSnapshot' = 'hermetic-e2e-v1'
            and "RunnerRun"."executionProvenance"->>'target' = 'e2e'
            and "RunnerRun"."executionProvenance"->>'lifecycle' = 'ephemeral')
        )
        and jsonb_typeof("RunnerRun"."executionProvenance"->'pinnedSnapshot') = 'string'
      ));
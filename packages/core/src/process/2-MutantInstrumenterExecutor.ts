import { Injector, tokens, commonTokens } from '@stryker-mutator/api/plugin';
import { Instrumenter, InstrumentResult } from '@stryker-mutator/instrumenter';
import { File, MutatorDescriptor } from '@stryker-mutator/api/core';

import { MainContext, coreTokens } from '../di';
import InputFileCollection from '../input/InputFileCollection';
import { Sandbox } from '../sandbox/sandbox';
import { LoggingClientContext } from '../logging';

import { ConcurrencyTokenProvider, createCheckerPool } from '../concurrent';
import { createCheckerFactory } from '../checker/CheckerFacade';

import { SandboxTSConfigRewriter } from '../sandbox';

import { DryRunContext } from './3-DryRunExecutor';

export interface MutantInstrumenterContext extends MainContext {
  [coreTokens.inputFiles]: InputFileCollection;
  [coreTokens.loggingContext]: LoggingClientContext;
}

export class MutantInstrumenterExecutor {
  public static readonly inject = tokens(commonTokens.injector, coreTokens.inputFiles, commonTokens.mutatorDescriptor);
  constructor(
    private readonly injector: Injector<MutantInstrumenterContext>,
    private readonly inputFiles: InputFileCollection,
    private readonly mutatorDescriptor: MutatorDescriptor
  ) {}

  public async execute(): Promise<Injector<DryRunContext>> {
    // Create the checker and instrumenter
    const instrumenter = this.injector.injectClass(Instrumenter);

    // Instrument files in-memory
    const instrumentResult = await instrumenter.instrument(this.inputFiles.filesToMutate, { plugins: this.mutatorDescriptor.plugins });

    // Rewrite tsconfig file references
    const tsconfigFileRewriter = this.injector.injectClass(SandboxTSConfigRewriter);
    const files = await tsconfigFileRewriter.rewrite(this.replaceWith(instrumentResult));

    // Initialize the checker pool
    const concurrencyTokenProviderProvider = this.injector.provideClass(coreTokens.concurrencyTokenProvider, ConcurrencyTokenProvider);
    const concurrencyTokenProvider = concurrencyTokenProviderProvider.resolve(coreTokens.concurrencyTokenProvider);

    const checkerPoolProvider = concurrencyTokenProviderProvider
      .provideValue(coreTokens.checkerConcurrencyTokens, concurrencyTokenProvider.checkerToken$)
      .provideFactory(coreTokens.checkerFactory, createCheckerFactory)
      .provideFactory(coreTokens.checkerPool, createCheckerPool);
    const checkerPool = checkerPoolProvider.resolve(coreTokens.checkerPool);
    await checkerPool.init();

    // Feed the sandbox
    const sandbox = await this.injector.provideValue(coreTokens.files, files).injectFunction(Sandbox.create);
    return checkerPoolProvider.provideValue(coreTokens.sandbox, sandbox).provideValue(coreTokens.mutants, instrumentResult.mutants);
  }

  private replaceWith(instrumentResult: InstrumentResult): File[] {
    return this.inputFiles.files.map((inputFile) => {
      const instrumentedFile = instrumentResult.files.find((instrumentedFile) => instrumentedFile.name === inputFile.name);
      if (instrumentedFile) {
        return instrumentedFile;
      } else {
        return inputFile;
      }
    });
  }
}

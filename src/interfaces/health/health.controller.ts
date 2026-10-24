import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { Public } from '@interfaces/http/public.decorator';
import { ReadinessService, type ReadinessReport } from './readiness.service';

export interface StatusResponse {
  status(code: number): { json(body: unknown): unknown };
}

@Controller('health')
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  @Get('live')
  @Public()
  live(): { readonly status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @Public()
  async ready(@Res() response: StatusResponse): Promise<void> {
    const report: ReadinessReport = await this.readiness.check();
    const status = report.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE;
    response.status(status).json(report);
  }
}

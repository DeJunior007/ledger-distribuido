import { Controller, Get, Res } from '@nestjs/common';
import { Public } from '@interfaces/http/public.decorator';

export abstract class MetricsSource {
  abstract readonly contentType: string;
  abstract metrics(): Promise<string>;
}

export interface MetricsResponse {
  type(contentType: string): { send(body: string): unknown };
}

@Controller('metrics')
export class MetricsController {
  constructor(private readonly source: MetricsSource) {}

  @Get()
  @Public()
  async metrics(@Res() response: MetricsResponse): Promise<void> {
    const body = await this.source.metrics();
    response.type(this.source.contentType).send(body);
  }
}

import { clone, create } from "@bufbuild/protobuf";
import { DurationSchema, TimestampSchema } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";

import {
  DeleteServiceAlarmResponseSchema,
  GetServiceAlarmResponseSchema,
  ListServiceAlarmsResponseSchema,
  PauseServiceAlarmResponseSchema,
  ResumeServiceAlarmResponseSchema,
  RunServiceAlarmNowResponseSchema,
  ServiceAlarmMisfire,
  ServiceAlarmOccurrenceSchema,
  ServiceAlarmSchema,
  SetServiceAlarmResponseSchema,
} from "../gen/toshi/workspace/v1/workloads_pb.js";
import type {
  DeleteServiceAlarmRequest,
  DeleteServiceAlarmResponse,
  GetServiceAlarmRequest,
  GetServiceAlarmResponse,
  ListServiceAlarmsRequest,
  ListServiceAlarmsResponse,
  PauseServiceAlarmRequest,
  PauseServiceAlarmResponse,
  ResumeServiceAlarmRequest,
  ResumeServiceAlarmResponse,
  RunServiceAlarmNowRequest,
  RunServiceAlarmNowResponse,
  ServiceAlarm,
  ServiceAlarmOccurrence,
  SetServiceAlarmRequest,
  SetServiceAlarmResponse,
} from "../gen/toshi/workspace/v1/workloads_pb.js";

/** How late a missed instant may be published when SetServiceAlarm names no deadline. */
const defaultStartingDeadline = create(DurationSchema, { seconds: 600n });

/** How many occurrences GetServiceAlarm returns. */
const maxOccurrences = 20;

/** One alarm the fake holds, and the occurrences RunServiceAlarmNow made for it, newest first. */
interface AlarmRecord {
  readonly serviceId: string;
  readonly name: string;
  alarm: ServiceAlarm;
  readonly occurrences: ServiceAlarmOccurrence[];
}

/**
 * The alarms the fake keeps for any service ID: the fake holds no services. It
 * has no clock, so an alarm publishes nothing on its own and a cron alarm has
 * no next instant.
 */
export class AlarmStore {
  private readonly alarms = new Map<string, AlarmRecord>();
  private readonly runs = new Map<string, ServiceAlarmOccurrence>();

  /** Creates the alarm at generation 1, or replaces it at the next generation, resumed. */
  set(request: SetServiceAlarmRequest): SetServiceAlarmResponse {
    const alarm = create(ServiceAlarmSchema, {
      name: request.name,
      timezone: request.timezone,
      channel: request.channel,
      event: request.event,
      data: request.data.slice(),
      misfire: request.misfire,
      startingDeadline: clone(DurationSchema, request.startingDeadline ?? defaultStartingDeadline),
      generation: 1n,
    });
    switch (request.schedule.case) {
      case "cron":
        alarm.schedule = { case: "cron", value: request.schedule.value };
        break;
      case "at":
        alarm.schedule = { case: "at", value: clone(TimestampSchema, request.schedule.value) };
        alarm.nextAt = clone(TimestampSchema, request.schedule.value);
        break;
    }
    if (alarm.misfire === ServiceAlarmMisfire.UNSPECIFIED) {
      alarm.misfire = ServiceAlarmMisfire.COALESCE;
    }
    const key = alarmKey(request.serviceId, request.name);
    const held = this.alarms.get(key);
    if (held === undefined) {
      this.alarms.set(key, {
        serviceId: request.serviceId,
        name: request.name,
        alarm,
        occurrences: [],
      });
    } else {
      alarm.generation = held.alarm.generation + 1n;
      held.alarm = alarm;
    }
    return create(SetServiceAlarmResponseSchema, { alarm: clone(ServiceAlarmSchema, alarm) });
  }

  /** Returns the alarm and its most recent occurrences, newest first. */
  get(request: GetServiceAlarmRequest): GetServiceAlarmResponse {
    const record = this.alarm(request.serviceId, request.name);
    return create(GetServiceAlarmResponseSchema, {
      alarm: clone(ServiceAlarmSchema, record.alarm),
      occurrences: record.occurrences
        .slice(0, maxOccurrences)
        .map((occurrence) => clone(ServiceAlarmOccurrenceSchema, occurrence)),
    });
  }

  /** Returns every alarm of the service, by name. */
  list(request: ListServiceAlarmsRequest): ListServiceAlarmsResponse {
    const alarms: ServiceAlarm[] = [];
    for (const record of this.alarms.values()) {
      if (record.serviceId === request.serviceId) {
        alarms.push(clone(ServiceAlarmSchema, record.alarm));
      }
    }
    alarms.sort((a, b) => compareNames(a.name, b.name));
    return create(ListServiceAlarmsResponseSchema, { alarms });
  }

  /** Removes an alarm and its occurrences. */
  delete(request: DeleteServiceAlarmRequest): DeleteServiceAlarmResponse {
    this.alarm(request.serviceId, request.name);
    this.alarms.delete(alarmKey(request.serviceId, request.name));
    return create(DeleteServiceAlarmResponseSchema, {});
  }

  /** Pauses an alarm; pausing a paused alarm changes nothing. */
  pause(request: PauseServiceAlarmRequest): PauseServiceAlarmResponse {
    const record = this.alarm(request.serviceId, request.name);
    record.alarm.paused = true;
    return create(PauseServiceAlarmResponseSchema, { alarm: clone(ServiceAlarmSchema, record.alarm) });
  }

  /** Resumes an alarm; resuming a running alarm changes nothing. */
  resume(request: ResumeServiceAlarmRequest): ResumeServiceAlarmResponse {
    const record = this.alarm(request.serviceId, request.name);
    record.alarm.paused = false;
    return create(ResumeServiceAlarmResponseSchema, { alarm: clone(ServiceAlarmSchema, record.alarm) });
  }

  /**
   * Records a manual occurrence at the alarm's generation. A request key the
   * fake has already answered returns the same occurrence.
   */
  runNow(request: RunServiceAlarmNowRequest): RunServiceAlarmNowResponse {
    if (request.requestKey !== "") {
      const answered = this.runs.get(request.requestKey);
      if (answered !== undefined) {
        return create(RunServiceAlarmNowResponseSchema, {
          occurrence: clone(ServiceAlarmOccurrenceSchema, answered),
        });
      }
    }
    const record = this.alarm(request.serviceId, request.name);
    const occurrence = create(ServiceAlarmOccurrenceSchema, {
      generation: record.alarm.generation,
      manual: true,
    });
    record.occurrences.unshift(occurrence);
    if (request.requestKey !== "") {
      this.runs.set(request.requestKey, occurrence);
    }
    return create(RunServiceAlarmNowResponseSchema, { occurrence: clone(ServiceAlarmOccurrenceSchema, occurrence) });
  }

  /** Returns the alarm of a service with this name. */
  private alarm(serviceId: string, name: string): AlarmRecord {
    const record = this.alarms.get(alarmKey(serviceId, name));
    if (record === undefined) {
      throw new ConnectError(`toshi: no alarm "${serviceId}/${name}"`, Code.NotFound);
    }
    return record;
  }
}

/** The map key of one alarm: its service and its name. */
function alarmKey(serviceId: string, name: string): string {
  return JSON.stringify([serviceId, name]);
}

/** Compares two names by the bytes of their UTF-8 encoding, as Go's strings.Compare does. */
function compareNames(a: string, b: string): number {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] < right[index] ? -1 : 1;
    }
  }
  return left.length - right.length;
}

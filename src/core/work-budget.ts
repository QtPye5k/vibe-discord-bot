import { UserError } from './errors.js';

/** One shared admission limit across image/PDF, Office and audio/video processors. */
export class WorkBudget {
  private active = 0;
  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('A positive work limit is required.');
  }
  enter(): () => void {
    if (this.active >= this.limit) throw new UserError('File processors are busy. Try again shortly.');
    this.active++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.active--;
      }
    };
  }
}
export const heavyWork = new WorkBudget(2);

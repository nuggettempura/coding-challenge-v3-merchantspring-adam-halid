import { sequelize } from "../src/config/database";

// Database round trips plus ts-jest compilation can exceed Jest's 5 second default.
jest.setTimeout(30000);

afterAll(async () => {
  await sequelize.close();
});
